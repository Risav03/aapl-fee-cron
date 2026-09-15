import { decodeEventLog, formatUnits, parseAbiItem, type Address, type Hex } from "viem";

import { DEAD } from "./allocate.ts";
import { publicClient } from "./chain.ts";
import { config } from "./config.ts";
import { log, logError } from "./log.ts";
import type { BurnKind, BurnRow } from "./store.ts";

const TRANSFER = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);
const CHUNK = 8_000n;
const LOOKBACK = 500_000n;

async function tokenDecimals(token: Address): Promise<number> {
  try {
    const decimals = await publicClient().readContract({
      address: token,
      abi: [
        {
          type: "function",
          name: "decimals",
          stateMutability: "view",
          inputs: [],
          outputs: [{ type: "uint8" }],
        },
      ] as const,
      functionName: "decimals",
    });
    return Number(decimals) || 18;
  } catch {
    return 18;
  }
}

export async function backfillBurnsFromChain(): Promise<BurnRow[]> {
  const cfg = config();
  const client = publicClient();
  const latest = await client.getBlockNumber();
  const fromBlock = latest > LOOKBACK ? latest - LOOKBACK : 0n;
  const wallet = cfg.feeWallet;
  const targets: Array<{ kind: BurnKind; token: Address }> = [
    { kind: "buy25", token: cfg.buyToken25 },
    { kind: "buy15", token: cfg.buyToken15 },
  ];

  const rows: BurnRow[] = [];
  const stamps = new Map<bigint, string>();

  for (const { kind, token } of targets) {
    const decimals = await tokenDecimals(token);
    for (let start = fromBlock; start <= latest; start += CHUNK + 1n) {
      const end = start + CHUNK > latest ? latest : start + CHUNK;
      let logs: Awaited<ReturnType<typeof client.getLogs>>;
      try {
        logs = await client.getLogs({
          address: token,
          event: TRANSFER,
          args: { from: wallet, to: DEAD },
          fromBlock: start,
          toBlock: end,
        });
      } catch (err) {
        logError(`backfill logs ${token} ${start}-${end}`, err);
        continue;
      }
      for (const item of logs) {
        const hash = item.transactionHash;
        const blockNumber = item.blockNumber;
        if (!hash || blockNumber == null) continue;
        let value = 0n;
        try {
          const decoded = decodeEventLog({
            abi: [TRANSFER],
            data: item.data as Hex,
            topics: item.topics as [Hex, ...Hex[]],
          });
          if (decoded.eventName !== "Transfer") continue;
          value = decoded.args.value;
        } catch {
          continue;
        }
        if (value <= 0n) continue;
        let at = stamps.get(blockNumber);
        if (!at) {
          const block = await client.getBlock({ blockNumber });
          at = new Date(Number(block.timestamp) * 1000).toISOString();
          stamps.set(blockNumber, at);
        }
        rows.push({
          kind,
          at,
          token,
          aaplIn: "",
          amountRaw: value.toString(),
          amount: formatUnits(value, decimals),
          decimals,
          swapTx: "",
          burnTx: hash,
        });
      }
    }
  }

  log(`on-chain backfill found ${rows.length} burn transfer(s)`);
  return rows;
}
