import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

import { config } from "./config.ts";

function makeClient() {
  return createPublicClient({
    chain: base,
    transport: http(config().rpcUrl),
  });
}

type ChainClient = ReturnType<typeof makeClient>;

let cached: ChainClient | undefined;

export function publicClient(): ChainClient {
  cached ??= makeClient();
  return cached;
}
