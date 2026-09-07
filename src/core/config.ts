import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  CHAIN_ID: z.coerce.number().default(4663),
  RPC_URL: z.string().optional().default(""),
  BLOCKSCOUT_API_KEY: z.string().optional().default(""),
  BLOCKSCOUT_API_BASE: z.string().optional().default("https://api.blockscout.com"),
  PAIR_ASSET_COINGECKO_ID: z.string().optional().default("ethereum"),
  SIGNAL_WINDOW_BLOCKS: z.coerce.number().default(50_000),
  WHALE_THRESHOLD_TOKENS: z.coerce.number().default(1_000_000),
  PORT: z.coerce.number().default(8787),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid configuration in .env:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

const env = parsed.data;

export const config = {
  chainId: env.CHAIN_ID,
  rpcUrl: env.RPC_URL,
  blockscoutApiKey: env.BLOCKSCOUT_API_KEY || undefined,
  blockscoutApiBase: env.BLOCKSCOUT_API_BASE,
  pairAssetCoingeckoId: env.PAIR_ASSET_COINGECKO_ID,
  signalWindowBlocks: BigInt(env.SIGNAL_WINDOW_BLOCKS),
  whaleThresholdTokens: env.WHALE_THRESHOLD_TOKENS,
  port: env.PORT,

  /** True when Blockscout's accelerated holder/tx endpoints are usable —
   *  otherwise providers must fall back to raw RPC log replay. */
  hasBlockscout(): boolean {
    return !!env.BLOCKSCOUT_API_KEY;
  },

  requireRpcUrl(): string {
    if (!env.RPC_URL) {
      throw new Error(
        "RPC_URL is not set in .env. See .env.example and https://docs.robinhood.com/chain/"
      );
    }
    return env.RPC_URL;
  },
};
