import { CdpClient } from "@coinbase/cdp-sdk";
import type { Address, Hex } from "viem";

import { config } from "./config.ts";
import { log } from "./log.ts";

export type WalletCall = {
  to: Address;
  data: Hex;
  value?: bigint;
};

export type SendResult = {
  userOpHash?: string;
  txHash: string;
  status?: string;
};

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function asAddress(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return ADDRESS_RE.test(trimmed) ? trimmed : null;
  }
  if (value && typeof value === "object" && "address" in value) {
    return asAddress((value as { address?: unknown }).address);
  }
  return null;
}

function resolveSendableSmartAddress(account: unknown, storedAddress: string): string | null {
  const stored = storedAddress.trim().toLowerCase();
  if (!ADDRESS_RE.test(stored) || !account || typeof account !== "object") return null;
  const row = account as {
    evmSmartAccounts?: unknown;
    evmSmartAccountObjects?: unknown;
  };
  for (const list of [row.evmSmartAccountObjects, row.evmSmartAccounts]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const addr = asAddress(item);
      if (addr && addr.toLowerCase() === stored) return addr;
    }
  }
  return null;
}

let client: CdpClient | null = null;

function cdp(): CdpClient {
  if (!client) {
    const { apiKeyId, apiKeySecret, walletSecret } = config().cdp;
    client = new CdpClient({ apiKeyId, apiKeySecret, walletSecret });
  }
  return client;
}

export async function sendCalls(calls: WalletCall[]): Promise<SendResult> {
  if (calls.length === 0) throw new Error("No calls were provided to execute.");
  const cfg = config();
  const endUser = await cdp().endUser.getEndUser({ userId: cfg.cdp.userId });
  const smart = resolveSendableSmartAddress(endUser, cfg.feeWallet);
  if (!smart) {
    throw new Error(
      `FEE_WALLET ${cfg.feeWallet} is not a smart account on CDP user ${cfg.cdp.userId}.`,
    );
  }

  const result = (await cdp().endUser.sendUserOperation({
    userId: cfg.cdp.userId,
    address: smart,
    network: "base",
    calls: calls.map((call) => ({
      to: call.to,
      data: call.data,
      value: (call.value ?? 0n).toString(),
    })),
    useCdpPaymaster: cfg.cdp.usePaymaster,
  })) as { userOpHash?: string | null; transactionHash?: string | null; status?: string };

  let txHash = result.transactionHash ?? undefined;
  let status = result.status;
  if (result.userOpHash && (!txHash || status !== "complete")) {
    const receipt = await cdp().evm.waitForUserOperation({
      smartAccountAddress: smart as `0x${string}`,
      userOpHash: result.userOpHash as `0x${string}`,
    });
    status = receipt.status;
    if (receipt.status !== "complete") {
      const revert =
        receipt &&
        typeof receipt === "object" &&
        "revert" in receipt &&
        receipt.revert &&
        typeof receipt.revert === "object" &&
        "message" in receipt.revert
          ? String((receipt.revert as { message?: unknown }).message ?? "")
          : "";
      throw new Error(
        revert
          ? `User operation failed — ${revert.slice(0, 200)}`
          : "User operation failed — the transaction reverted on Base.",
      );
    }
    txHash = receipt.transactionHash;
  }
  if (status && status !== "complete") {
    throw new Error(
      status === "failed"
        ? "User operation failed — the transaction reverted on Base."
        : `User operation ${status}.`,
    );
  }
  if (!txHash) {
    throw new Error("User operation completed without a transaction hash.");
  }
  log(`userOp mined ${txHash} (${calls.length} call${calls.length === 1 ? "" : "s"})`);
  return { userOpHash: result.userOpHash ?? undefined, txHash, status };
}
