import "dotenv/config";

import { getAddress, type Address } from "viem";

const DEFAULT_FEE_WALLET = "0xa56a71986f6e27d50a15b4bab65d63aa870db93a";
const DEFAULT_AAPL = "0xb200000000000000000000c2e324d24d7eecd1fb";
const DEFAULT_BUY_25 = "0xCB2BAff7177C8966A8b059b3Df3e9323dc2Ee267";
const DEFAULT_BUY_15 = "0x07E61D8a4e197dfC269e90D7ECe1dF0D26702bA3";
const DEFAULT_TREASURY = "0x9Ac43a462762559c13833A3F44b3666954238aad";
const DEFAULT_FEE_LOCKER = "0x71D1D363176723f85d98B8B430DF33cde89f0A7f";

export const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as Address;
export const ZERO = "0x0000000000000000000000000000000000000000" as Address;

function required(name: string): string {
  const value = (process.env[name] ?? "").trim();
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  const value = (process.env[name] ?? "").trim();
  return value || fallback;
}

function addr(name: string, fallback: string): Address {
  return getAddress(optional(name, fallback));
}

function flag(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

function int(name: string, fallback: number): number {
  const n = Number((process.env[name] ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function loadConfig() {
  return {
    port: int("PORT", 3000),
    serviceApiKey: (process.env.SERVICE_API_KEY ?? "").trim(),
    rpcUrl: required("BASE_RPC_URL"),
    cdp: {
      apiKeyId: required("CDP_API_KEY_ID"),
      apiKeySecret: required("CDP_API_KEY_SECRET"),
      walletSecret: required("CDP_WALLET_SECRET"),
      userId: required("CDP_USER_ID"),
      usePaymaster: flag("USE_CDP_PAYMASTER", true),
    },
    feeWallet: addr("FEE_WALLET", DEFAULT_FEE_WALLET),
    aaplToken: addr("AAPL_TOKEN", DEFAULT_AAPL),
    buyToken25: addr("BUY_TOKEN_25", DEFAULT_BUY_25),
    buyToken15: addr("BUY_TOKEN_15", DEFAULT_BUY_15),
    istonksToken: addr("ISTONKS_TOKEN", DEFAULT_BUY_25),
    treasury: addr("TREASURY", DEFAULT_TREASURY),
    vault: addr("VAULT", optional("TREASURY", DEFAULT_TREASURY)),
    feeLocker: addr("STONKS_FEE_LOCKER", DEFAULT_FEE_LOCKER),
    stonksAppUrl: optional("STONKS_APP_URL", "https://thestonks.exchange").replace(/\/$/, ""),
    slippageBps: int("SLIPPAGE_BPS", 300),
    minAaplWei: (process.env.MIN_AAPL_WEI ?? "").trim()
      ? BigInt(process.env.MIN_AAPL_WEI as string)
      : null,
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;

let cached: AppConfig | null = null;

export function config(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

export function configReady(): { ok: boolean; missing: string[] } {
  const names = [
    "CDP_API_KEY_ID",
    "CDP_API_KEY_SECRET",
    "CDP_WALLET_SECRET",
    "CDP_USER_ID",
    "BASE_RPC_URL",
  ];
  const missing = names.filter((name) => !(process.env[name] ?? "").trim());
  return { ok: missing.length === 0, missing };
}
