import { allocateAapl, type AllocateResult } from "./allocate.ts";
import { claimFees, type ClaimResult } from "./claim.ts";
import { log, logError, sleep } from "./log.ts";
import { recordBurns, type StoreResult } from "./store.ts";

export type SweepResult = {
  startedAt: string;
  finishedAt: string;
  skipped?: string;
  claim?: ClaimResult;
  allocate?: AllocateResult;
  store?: StoreResult;
  error?: string;
};

let running = false;

export function isSweepRunning(): boolean {
  return running;
}

export async function runSweep(): Promise<SweepResult> {
  const startedAt = new Date().toISOString();
  if (running) {
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      skipped: "already running",
    };
  }

  running = true;
  log("sweep started");
  try {
    const claim = await claimFees();
    if (claim.txHash) await sleep(4_000);
    const allocate = await allocateAapl();
    const store = await recordBurns(allocate, startedAt);
    const result: SweepResult = {
      startedAt,
      finishedAt: new Date().toISOString(),
      claim,
      allocate,
      store,
    };
    log("sweep finished", result);
    return result;
  } catch (err) {
    logError("sweep failed", err);
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    running = false;
  }
}
