import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AllocateResult, BuyBurnLeg } from "./allocate.ts";
import { log, logError } from "./log.ts";

export type BurnKind = "buy25" | "buy15";

export type BurnRow = {
  kind: BurnKind;
  at: string;
  token: string;
  aaplIn: string;
  amountRaw: string;
  amount: string;
  decimals: number;
  swapTx: string;
  burnTx: string;
};

export type StoreResult = {
  skipped?: string;
  path?: string;
  added?: number;
  total?: number;
};

const HEADER =
  "kind,at,token,aapl_in,amount_raw,amount,decimals,swap_tx,burn_tx";

function dataDir(): string {
  const raw = (process.env.DATA_DIR ?? "").trim();
  return raw || path.join(process.cwd(), "data");
}

export function burnsCsvPath(): string {
  return path.join(dataDir(), "burns.csv");
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

function isBurnKind(value: string): value is BurnKind {
  return value === "buy25" || value === "buy15";
}

function parseRow(line: string): BurnRow | null {
  const cols = splitCsvLine(line);
  if (cols.length < 9) return null;
  const kind = (cols[0] ?? "").trim();
  const burnTx = (cols[8] ?? "").trim();
  const token = (cols[2] ?? "").trim();
  const amountRaw = (cols[4] ?? "").trim();
  if (!isBurnKind(kind)) return null;
  if (!/^0x[a-fA-F0-9]{64}$/.test(burnTx)) return null;
  if (!/^0x[a-fA-F0-9]{40}$/.test(token)) return null;
  if (!/^\d+$/.test(amountRaw) || amountRaw === "0") return null;
  const decimals = Number(cols[6] ?? 18);
  return {
    kind,
    at: (cols[1] ?? "").trim(),
    token,
    aaplIn: (cols[3] ?? "").trim(),
    amountRaw,
    amount: (cols[5] ?? "").trim(),
    decimals: Number.isFinite(decimals) ? decimals : 18,
    swapTx: (cols[7] ?? "").trim(),
    burnTx,
  };
}

function serialize(row: BurnRow): string {
  return [
    row.kind,
    csvEscape(row.at),
    row.token,
    csvEscape(row.aaplIn),
    row.amountRaw,
    csvEscape(row.amount),
    String(row.decimals),
    row.swapTx,
    row.burnTx,
  ].join(",");
}

function hasBurn(leg: BuyBurnLeg | undefined): leg is BuyBurnLeg {
  const burn = (leg?.burnTxHash ?? "").trim();
  const out = (leg?.tokenOutRaw ?? "").trim();
  return Boolean(leg && /^0x[a-fA-F0-9]{64}$/.test(burn) && /^\d+$/.test(out) && out !== "0");
}

function toRow(kind: BurnKind, at: string, leg: BuyBurnLeg): BurnRow {
  return {
    kind,
    at,
    token: leg.token,
    aaplIn: leg.amount,
    amountRaw: leg.tokenOutRaw ?? "0",
    amount: leg.tokenOut ?? "0",
    decimals: leg.tokenDecimals ?? 18,
    swapTx: (leg.txHash ?? "").trim(),
    burnTx: (leg.burnTxHash ?? "").trim(),
  };
}

export async function readBurnRows(): Promise<BurnRow[]> {
  try {
    const text = await readFile(burnsCsvPath(), "utf8");
    const lines = text.trim().split(/\r?\n/).filter(Boolean);
    const start = lines[0]?.startsWith("kind,") ? 1 : 0;
    const byTx = new Map<string, BurnRow>();
    for (const line of lines.slice(start)) {
      const row = parseRow(line);
      if (!row) continue;
      byTx.set(row.burnTx.toLowerCase(), row);
    }
    return [...byTx.values()].sort((a, b) => a.at.localeCompare(b.at));
  } catch {
    return [];
  }
}

export async function readBurnsCsv(): Promise<string> {
  const rows = await readBurnRows();
  return `${HEADER}\n${rows.map(serialize).join("\n")}${rows.length ? "\n" : ""}`;
}

export async function recordBurns(
  allocate: AllocateResult,
  startedAt: string,
): Promise<StoreResult> {
  const incoming: BurnRow[] = [];
  if (hasBurn(allocate.buy25)) incoming.push(toRow("buy25", startedAt, allocate.buy25));
  if (hasBurn(allocate.buy15)) incoming.push(toRow("buy15", startedAt, allocate.buy15));
  if (incoming.length === 0) {
    return { skipped: "no burns to store" };
  }

  try {
    const existing = await readBurnRows();
    const byTx = new Map(existing.map((row) => [row.burnTx.toLowerCase(), row]));
    let added = 0;
    for (const row of incoming) {
      const key = row.burnTx.toLowerCase();
      if (byTx.has(key)) continue;
      byTx.set(key, row);
      added += 1;
    }
    const rows = [...byTx.values()].sort((a, b) => a.at.localeCompare(b.at));
    const filePath = burnsCsvPath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      `${HEADER}\n${rows.map(serialize).join("\n")}${rows.length ? "\n" : ""}`,
      "utf8",
    );
    log(`stored ${added} burn(s) in ${filePath} (${rows.length} total)`);
    return { path: filePath, added, total: rows.length };
  } catch (err) {
    logError("burn csv write failed", err);
    return { skipped: err instanceof Error ? err.message : String(err) };
  }
}

export function burnsPayload(rows: BurnRow[]) {
  return {
    updatedAt: new Date().toISOString(),
    count: rows.length,
    burns: rows,
  };
}
