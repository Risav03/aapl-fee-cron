import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  parseUnits,
  type Address,
  type Hex,
} from "viem";

import { sendCalls, type WalletCall } from "./cdp.ts";
import { publicClient } from "./chain.ts";
import { config } from "./config.ts";
import { log, sleep } from "./log.ts";

const KYBER_BASE_API = "https://aggregator-api.kyberswap.com/base/api/v1";
const KYBER_HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
  "x-client-id": "aapl-fee-cron",
};
const SWAP_QUOTES = 3;

export type Split = {
  buy25: bigint;
  buy15: bigint;
  treasury: bigint;
};

export const DEAD = "0x000000000000000000000000000000000000dEaD" as Address;
const SETTLE_DELAY_MS = 5_000;

export type BuyBurnLeg = {
  amount: string;
  token: string;
  txHash?: string;
  tokenOut?: string;
  tokenOutRaw?: string;
  tokenDecimals?: number;
  burnTxHash?: string;
  skipped?: string;
};

export type AllocateResult = {
  skipped?: string;
  aapl: string;
  aaplRaw: string;
  buy25?: BuyBurnLeg;
  buy15?: BuyBurnLeg;
  treasury?: { amount: string; to: string; txHash?: string };
};

type KyberRouteSummary = Record<string, unknown> & { amountOut?: string };

function parseWei(value: string | undefined): bigint {
  if (!value || value === "0x" || value === "0x0") return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

export function splitAapl(amount: bigint): Split {
  const buy25 = (amount * 25n) / 100n;
  const buy15 = (amount * 15n) / 100n;
  return { buy25, buy15, treasury: amount - buy25 - buy15 };
}

export async function readTokenBalance(token: Address, owner: Address): Promise<bigint> {
  return publicClient().readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
}

async function tokenDecimals(token: Address): Promise<number> {
  try {
    const decimals = await publicClient().readContract({
      address: token,
      abi: erc20Abi,
      functionName: "decimals",
    });
    return Number(decimals) || 18;
  } catch {
    return 18;
  }
}

async function fetchKyberRoute(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<KyberRouteSummary> {
  const url = `${KYBER_BASE_API}/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`;
  const res = await fetch(url, {
    headers: KYBER_HEADERS,
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Kyber routes: HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { routeSummary?: KyberRouteSummary } };
  const summary = json.data?.routeSummary;
  if (!summary?.amountOut) throw new Error("Kyber returned no route");
  return summary;
}

async function buildKyberSwap(opts: {
  routeSummary: KyberRouteSummary;
  wallet: Address;
}): Promise<{ router: Address; data: Hex; value: bigint }> {
  const res = await fetch(`${KYBER_BASE_API}/route/build`, {
    method: "POST",
    headers: KYBER_HEADERS,
    body: JSON.stringify({
      routeSummary: opts.routeSummary,
      sender: opts.wallet,
      recipient: opts.wallet,
      slippageTolerance: config().slippageBps,
    }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Kyber build: HTTP ${res.status}`);
  const json = (await res.json()) as {
    data?: { routerAddress?: string; data?: string; transactionValue?: string };
  };
  const built = json.data;
  if (!built?.routerAddress || !built.data) {
    throw new Error("Kyber build returned no calldata");
  }
  return {
    router: getAddress(built.routerAddress),
    data: built.data as Hex,
    value: parseWei(built.transactionValue),
  };
}

async function allowance(token: Address, owner: Address, spender: Address): Promise<bigint> {
  return publicClient().readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  });
}

function approveCall(token: Address, spender: Address, amount: bigint): WalletCall {
  return {
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, amount],
    }),
  };
}

async function swapAapl(tokenOut: Address, amountIn: bigint): Promise<string> {
  const cfg = config();
  const wallet = cfg.feeWallet;
  let lastError = "Kyber swap failed";

  for (let attempt = 0; attempt < SWAP_QUOTES; attempt++) {
    try {
      const summary = await fetchKyberRoute(cfg.aaplToken, tokenOut, amountIn);
      const built = await buildKyberSwap({ routeSummary: summary, wallet });
      const calls: WalletCall[] = [];
      const current = await allowance(cfg.aaplToken, wallet, built.router);
      if (current < amountIn) {
        calls.push(approveCall(cfg.aaplToken, built.router, amountIn));
      }
      calls.push({
        to: built.router,
        data: built.data,
        value: built.value,
      });
      const sent = await sendCalls(calls);
      return sent.txHash;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log(`swap quote ${attempt + 1}/${SWAP_QUOTES} failed: ${lastError}`);
      if (attempt < SWAP_QUOTES - 1) await sleep(1_200 + attempt * 800);
    }
  }
  throw new Error(lastError);
}

async function waitForBalanceChange(
  token: Address,
  owner: Address,
  previous: bigint,
): Promise<bigint> {
  let balance = await readTokenBalance(token, owner);
  for (let i = 0; i < 8 && balance <= previous; i++) {
    await sleep(400 + i * 200);
    balance = await readTokenBalance(token, owner);
  }
  return balance;
}

async function burnToken(token: Address, amount: bigint): Promise<string> {
  const sent = await sendCalls([
    {
      to: token,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [DEAD, amount],
      }),
    },
  ]);
  return sent.txHash;
}

export async function burnHeldToken(token: Address): Promise<{
  amount: bigint;
  formatted: string;
  decimals: number;
  burnTxHash?: string;
  skipped?: string;
}> {
  const wallet = config().feeWallet;
  const decimals = await tokenDecimals(token);
  const balance = await readTokenBalance(token, wallet);
  const formatted = formatUnits(balance, decimals);
  if (balance <= 0n) {
    return { amount: 0n, formatted, decimals, skipped: "zero balance" };
  }
  log(`burning ${formatted} ${token}`);
  const burnTxHash = await burnToken(token, balance);
  return { amount: balance, formatted, decimals, burnTxHash };
}

async function swapThenBurn(tokenOut: Address, amountIn: bigint): Promise<BuyBurnLeg> {
  const cfg = config();
  const aaplDecimals = await tokenDecimals(cfg.aaplToken);
  const wallet = cfg.feeWallet;
  const before = await readTokenBalance(tokenOut, wallet);
  const txHash = await swapAapl(tokenOut, amountIn);
  await sleep(SETTLE_DELAY_MS);
  await waitForBalanceChange(tokenOut, wallet, before);
  const burned = await burnHeldToken(tokenOut);
  const leg: BuyBurnLeg = {
    amount: formatUnits(amountIn, aaplDecimals),
    token: tokenOut,
    txHash,
    tokenOut: burned.formatted,
    tokenOutRaw: burned.amount.toString(),
    tokenDecimals: burned.decimals,
    burnTxHash: burned.burnTxHash,
    skipped: burned.skipped,
  };
  if (!burned.burnTxHash) {
    log(`burn skipped after swap ${txHash}: ${burned.skipped ?? "no balance"}`);
  }
  return leg;
}

async function transferAapl(to: Address, amount: bigint): Promise<string> {
  const sent = await sendCalls([
    {
      to: config().aaplToken,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [to, amount],
      }),
    },
  ]);
  return sent.txHash;
}

export async function allocateAapl(): Promise<AllocateResult> {
  const cfg = config();
  const decimals = await tokenDecimals(cfg.aaplToken);
  const min = cfg.minAaplWei ?? parseUnits("0.01", decimals);
  const balance = await readTokenBalance(cfg.aaplToken, cfg.feeWallet);
  const formatted = formatUnits(balance, decimals);

  if (balance < min) {
    log(`allocate skipped — AAPLc ${formatted} below min ${formatUnits(min, decimals)}`);
    const result: AllocateResult = {
      skipped: `AAPLc ${formatted} below min`,
      aapl: formatted,
      aaplRaw: balance.toString(),
    };
    await burnLeftoverBuyTokens(result);
    return result;
  }

  const split = splitAapl(balance);
  log(
    `allocating ${formatted} AAPLc → 25% ${formatUnits(split.buy25, decimals)} / 15% ${formatUnits(split.buy15, decimals)} / treasury ${formatUnits(split.treasury, decimals)}`,
  );

  const result: AllocateResult = {
    aapl: formatted,
    aaplRaw: balance.toString(),
  };

  if (split.buy25 > 0n) {
    result.buy25 = await swapThenBurn(cfg.buyToken25, split.buy25);
  }
  if (split.buy15 > 0n) {
    result.buy15 = await swapThenBurn(cfg.buyToken15, split.buy15);
  }
  if (split.treasury > 0n) {
    const txHash = await transferAapl(cfg.treasury, split.treasury);
    result.treasury = {
      amount: formatUnits(split.treasury, decimals),
      to: cfg.treasury,
      txHash,
    };
  }
  await burnLeftoverBuyTokens(result);
  return result;
}

async function burnLeftoverBuyTokens(result: AllocateResult): Promise<void> {
  const cfg = config();
  if (!result.buy25?.burnTxHash) {
    const burned = await burnHeldToken(cfg.buyToken25);
    if (burned.burnTxHash) {
      result.buy25 = {
        amount: result.buy25?.amount ?? "0",
        token: cfg.buyToken25,
        txHash: result.buy25?.txHash,
        tokenOut: burned.formatted,
        tokenOutRaw: burned.amount.toString(),
        tokenDecimals: burned.decimals,
        burnTxHash: burned.burnTxHash,
      };
    }
  }
  if (!result.buy15?.burnTxHash) {
    const burned = await burnHeldToken(cfg.buyToken15);
    if (burned.burnTxHash) {
      result.buy15 = {
        amount: result.buy15?.amount ?? "0",
        token: cfg.buyToken15,
        txHash: result.buy15?.txHash,
        tokenOut: burned.formatted,
        tokenOutRaw: burned.amount.toString(),
        tokenDecimals: burned.decimals,
        burnTxHash: burned.burnTxHash,
      };
    }
  }
}
