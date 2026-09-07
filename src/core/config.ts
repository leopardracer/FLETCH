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
  DB_PATH: z.string().optional().default("./fletch.db"),
  ENABLE_POLLER: z.coerce.boolean().default(true),
  POLL_INTERVAL_MS: z.coerce.number().default(300_000), // 5 min — see docs/ARCHITECTURE.md on why this isn't more aggressive against a shared public RPC
  POLL_TOKEN_LIMIT: z.coerce.number().default(15),
  SNAPSHOT_MIN_INTERVAL_SECONDS: z.coerce.number().default(60), // don't record near-duplicate snapshots from rapid page views
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
  dbPath: env.DB_PATH,
  enablePoller: env.ENABLE_POLLER,
  pollIntervalMs: env.POLL_INTERVAL_MS,
  pollTokenLimit: env.POLL_TOKEN_LIMIT,
  snapshotMinIntervalSeconds: env.SNAPSHOT_MIN_INTERVAL_SECONDS,

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
