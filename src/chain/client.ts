import { createPublicClient, http, defineChain } from "viem";
import { config } from "../core/config.js";

export const robinhoodChain = defineChain({
  id: config.chainId,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [] }, // intentionally empty — RPC_URL is required explicitly
  },
  // Only declared when MULTICALL3_ADDRESS is set and verified by the operator —
  // see core/config.ts. Never assumed from another chain's canonical address.
  ...(config.multicall3Address ? { contracts: { multicall3: { address: config.multicall3Address } } } : {}),
});

let _client: ReturnType<typeof createPublicClient> | null = null;

export function getClient() {
  if (_client) return _client;
  _client = createPublicClient({
    chain: robinhoodChain,
    transport: http(config.requireRpcUrl()),
    // With a verified Multicall3, viem aggregates concurrent readContract
    // calls into one eth_call (e.g. chain/token.ts's 4 metadata reads → 1).
    ...(config.multicall3Address ? { batch: { multicall: true } } : {}),
  });
  return _client;
}

export type ChainPingResult = { ok: true; blockNumber: bigint } | { ok: false; reason: string };

export async function pingChain(): Promise<ChainPingResult> {
  try {
    const client = getClient();
    const blockNumber = await client.getBlockNumber();
    return { ok: true, blockNumber };
  } catch (e: any) {
    return { ok: false, reason: e?.shortMessage ?? e?.message ?? "unknown error" };
  }
}
