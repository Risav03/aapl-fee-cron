import { encodeFunctionData, getAddress, type Address } from "viem";

import { feeLockerAbi } from "./abis.ts";
import { publicClient } from "./chain.ts";
import type { WalletCall } from "./cdp.ts";
import { sendCalls } from "./cdp.ts";
import { config, WETH_ADDRESS, ZERO } from "./config.ts";
import { log } from "./log.ts";

export type IndexedCoin = {
  token: Address;
  creator: Address;
  quote: Address;
};

export type ClaimResult = {
  skipped?: string;
  coins: number;
  collect: string[];
  claimed: string[];
  txHash?: string;
};

function asAddress(value: unknown): Address | null {
  if (typeof value !== "string") return null;
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}

export function parseCoinsPayload(body: unknown): IndexedCoin[] {
  const raw =
    body && typeof body === "object" && "coins" in body
      ? (body as { coins?: unknown }).coins
      : body;
  if (!Array.isArray(raw)) return [];
  const out: IndexedCoin[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const token = asAddress(row.token);
    const creator = asAddress(row.creator);
    if (!token || !creator) continue;
    out.push({
      token,
      creator,
      quote: asAddress(row.quote) ?? ZERO,
    });
  }
  return out;
}

export async function loadCoinsByCreator(creator: Address): Promise<IndexedCoin[]> {
  const url = `${config().stonksAppUrl}/api/coins`;
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Stonks indexer HTTP ${res.status}`);
  }
  const coins = parseCoinsPayload(await res.json());
  const key = creator.toLowerCase();
  return coins.filter((coin) => coin.creator.toLowerCase() === key);
}

function uniqueAddresses(values: Array<string | null | undefined>): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const raw of values) {
    if (!raw || raw.toLowerCase() === ZERO) continue;
    try {
      const next = getAddress(raw);
      const key = next.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(next);
    } catch {
      /* skip */
    }
  }
  return out;
}

export async function buildClaimCalls(wallet: Address): Promise<{
  calls: WalletCall[];
  collect: Address[];
  claimed: Address[];
  coins: number;
}> {
  const cfg = config();
  const client = publicClient();
  const coins = await loadCoinsByCreator(wallet);
  const collect: Address[] = [];

  for (const coin of coins) {
    try {
      const positions = (await client.readContract({
        address: cfg.feeLocker,
        abi: feeLockerAbi,
        functionName: "positionsOf",
        args: [coin.token],
      })) as readonly bigint[];
      if (positions.length > 0) collect.push(coin.token);
    } catch (err) {
      log(`positionsOf skipped ${coin.token}`, err instanceof Error ? err.message : err);
    }
  }

  const claimAssets = uniqueAddresses([
    cfg.aaplToken,
    WETH_ADDRESS,
    ...coins.map((coin) => coin.quote),
    ...coins.map((coin) => coin.token),
  ]);
  const claimed: Address[] = [];
  for (const token of claimAssets) {
    try {
      const amount = (await client.readContract({
        address: cfg.feeLocker,
        abi: feeLockerAbi,
        functionName: "claimable",
        args: [wallet, token],
      })) as bigint;
      if (amount > 0n) claimed.push(token);
    } catch (err) {
      log(`claimable skipped ${token}`, err instanceof Error ? err.message : err);
    }
  }

  const calls: WalletCall[] = [];
  for (const token of collect) {
    calls.push({
      to: cfg.feeLocker,
      data: encodeFunctionData({
        abi: feeLockerAbi,
        functionName: "collectAll",
        args: [token],
      }),
    });
  }
  for (const token of claimed) {
    calls.push({
      to: cfg.feeLocker,
      data: encodeFunctionData({
        abi: feeLockerAbi,
        functionName: "claim",
        args: [token],
      }),
    });
  }

  return { calls, collect, claimed, coins: coins.length };
}

export async function claimFees(): Promise<ClaimResult> {
  const wallet = config().feeWallet;
  const plan = await buildClaimCalls(wallet);
  if (plan.calls.length === 0) {
    log(`claim skipped — no collectAll/claim work (${plan.coins} indexed coins)`);
    return {
      skipped: "nothing to collect or claim",
      coins: plan.coins,
      collect: [],
      claimed: [],
    };
  }
  log(
    `claiming ${plan.collect.length} collectAll + ${plan.claimed.length} claim across ${plan.coins} coins`,
  );
  const sent = await sendCalls(plan.calls);
  return {
    coins: plan.coins,
    collect: plan.collect,
    claimed: plan.claimed,
    txHash: sent.txHash,
  };
}
