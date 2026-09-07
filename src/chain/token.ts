import { getClient } from "./client.js";
import { ImmutableCache } from "../core/cache.js";

export const erc20Abi = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

export interface TokenInfo {
  address: `0x${string}`;
  symbol: string | null;
  name: string | null;
  decimals: number;
  totalSupply: bigint | null;
  contractExists: boolean;
}

/** Reads token metadata for any address. Symbol/name/decimals never
 *  change once deployed, so this is cached for the life of the process —
 *  see docs/DEVELOPMENT.md#performance. */
const tokenInfoCache = new ImmutableCache<string, TokenInfo>();

export async function readTokenInfo(address: `0x${string}`): Promise<TokenInfo> {
  return tokenInfoCache.getOrCompute(address.toLowerCase(), () => readTokenInfoUncached(address));
}

async function readTokenInfoUncached(address: `0x${string}`): Promise<TokenInfo> {
  const client = getClient();

  const bytecode = await client.getBytecode({ address });
  const contractExists = !!bytecode && bytecode !== "0x";

  if (!contractExists) {
    return { address, symbol: null, name: null, decimals: 18, totalSupply: null, contractExists: false };
  }

  const [symbol, name, decimals, totalSupply] = await Promise.allSettled([
    client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address, abi: erc20Abi, functionName: "name" }),
    client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address, abi: erc20Abi, functionName: "totalSupply" }),
  ]);

  return {
    address,
    symbol: symbol.status === "fulfilled" ? (symbol.value as string) : null,
    name: name.status === "fulfilled" ? (name.value as string) : null,
    decimals: decimals.status === "fulfilled" ? Number(decimals.value) : 18,
    totalSupply: totalSupply.status === "fulfilled" ? (totalSupply.value as bigint) : null,
    contractExists: true,
  };
}
