import { createPublicClient, http, defineChain } from "viem";
import { config } from "../core/config.js";

export const robinhoodChain = defineChain({
  id: config.chainId,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [] }, // intentionally empty — RPC_URL is required explicitly
  },
});

let _client: ReturnType<typeof createPublicClient> | null = null;

export function getClient() {
  if (_client) return _client;
  _client = createPublicClient({
    chain: robinhoodChain,
    transport: http(config.requireRpcUrl()),
  });
  return _client;
}

export async function pingChain(): Promise<{ ok: true; blockNumber: bigint } | { ok: false; reason: string }> {
  try {
    const client = getClient();
    const blockNumber = await client.getBlockNumber();
    return { ok: true, blockNumber };
  } catch (e: any) {
    return { ok: false, reason: e?.shortMessage ?? e?.message ?? "unknown error" };
  }
}
