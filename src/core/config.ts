import "dotenv/config";
import { z } from "zod";

/**
 * z.coerce.boolean() uses JS's Boolean(value) coercion, which makes the
 * *string* "false" coerce to `true` (any non-empty string is truthy) —
 * a real footgun for an env-var boolean, since env vars are always
 * strings. This treats "false"/"0"/"no"/"off" (case-insensitive) as
 * false and everything else as true, matching normal env-var convention.
 * Caught by src/core/config.test.ts.
 */
const zBooleanEnv = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .default(String(defaultValue))
    .transform((v) => !["false", "0", "no", "off", ""].includes(v.trim().toLowerCase()));

const envSchema = z.object({
  CHAIN_ID: z.coerce.number().default(4663),
  RPC_URL: z.string().optional().default(""),
  BLOCKSCOUT_API_KEY: z.string().optional().default(""),
  BLOCKSCOUT_API_BASE: z.string().optional().default("https://api.blockscout.com"),
  PAIR_ASSET_COINGECKO_ID: z.string().optional().default("ethereum"),
  SIGNAL_WINDOW_BLOCKS: z.coerce.number().default(50_000),
  WHALE_THRESHOLD_TOKENS: z.coerce.number().default(1_000_000),
  PORT: z.coerce.number().default(8787),
  // Behind a hosting proxy (Railway, Fly, nginx) set to 1 so rate limits apply
  // per visitor, not to the proxy's single IP (which would throttle everyone together).
  TRUST_PROXY: z.coerce.number().default(0),
  DB_PATH: z.string().optional().default("./fletch.db"),
  ENABLE_POLLER: zBooleanEnv(true),
  POLL_INTERVAL_MS: z.coerce.number().default(300_000), // 5 min — see docs/ARCHITECTURE.md on why this isn't more aggressive against a shared public RPC
  POLL_TOKEN_LIMIT: z.coerce.number().default(15),
  SNAPSHOT_MIN_INTERVAL_SECONDS: z.coerce.number().default(60), // don't record near-duplicate snapshots from rapid page views

  // --- Continuous monitoring (docs/MONITORING.md) ---
  ACTIVITY_SWEEP_INTERVAL_MS: z.coerce.number().default(60_000), // how often to check every watched curve for new trades in one batched read (monitoring/activitySweep.ts)
  DISCOVERY_INTERVAL_MS: z.coerce.number().default(300_000), // how often to scan for new launches and add them to the monitoring queue
  MAX_CONCURRENT_TOKENS: z.coerce.number().default(5), // in-flight chain reads per monitoring cycle — bounds RPC load regardless of queue size
  MAX_MONITORED_TOKENS: z.coerce.number().default(500), // hard cap on the monitoring queue — bounded storage/RPC even if launches vastly outpace check capacity
  MAX_CONSECUTIVE_FAILURES: z.coerce.number().default(5), // a token failing this many checks in a row is marked FAILED and stops being scheduled, so one permanently-broken address can't retry forever
  FAILED_REACTIVATE_AFTER_SECONDS: z.coerce.number().default(21_600), // a FAILED token gets a fresh set of retries after this cool-off (6h) instead of needing a process restart; 0 disables
  RPC_BACKOFF_BASE_MS: z.coerce.number().default(60_000), // first pause after an RPC rate-limit error; doubles on each consecutive one
  RPC_BACKOFF_MAX_MS: z.coerce.number().default(3_600_000), // ceiling for that pause — also used directly for a provider's daily-quota error
  // Optional: address of a Multicall3 contract on this chain. When set, concurrent
  // readContract calls (e.g. a token's name/symbol/decimals/totalSupply) are
  // aggregated into ONE eth_call. Left unset by default because it's only safe
  // once verified — check `eth_getCode` at the address returns non-empty bytecode.
  MULTICALL3_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional().or(z.literal("")).default(""),
  SIGNAL_RETENTION_DAYS: z.coerce.number().default(30),
  SNAPSHOT_RETENTION_DAYS: z.coerce.number().default(30),

  // --- Log-scan bounds (chain/holders.ts) ---
  // A holder count is computed by replaying every Transfer log for a
  // token from its launch block — real, exact, but O(transfers) in RPC
  // log volume. Confirmed against live Robinhood Chain mainnet: a single
  // eth_getLogs call spanning ~237,000 blocks (an older token's full
  // history) was rejected by the public RPC. These two bound that read.
  LOG_SCAN_CHUNK_BLOCKS: z.coerce.number().default(2_000), // max block range per single eth_getLogs call
  // A launch is DEAD once its curve holds almost nothing and nobody has traded
  // for a while (found live: dead launches re-emitted "liquidity is only $0"
  // every check and filled the radar). Dead tokens leave the radar and feed
  // and are re-checked rarely, so a revival is still caught.
  DEAD_LIQUIDITY_ETH: z.coerce.number().default(0.001),
  DEAD_AFTER_BLOCKS: z.coerce.number().default(50_000), // ≈3.5h on Robinhood Chain
  DEAD_RECHECK_SECONDS: z.coerce.number().default(6 * 3600),
  MAX_HOLDER_BACKFILL_BLOCKS: z.coerce.number().default(400_000), // first-time lifetime backfill from launch (≈28h on Robinhood Chain); older tokens fall back to a bounded window, never claimed as lifetime
  MAX_HOLDER_SCAN_BLOCKS: z.coerce.number().default(20_000), // how far back a holder scan will ever look, even for an old token

  // --- API rate limiting (api/server.ts) ---
  // Generous enough that normal local dashboard usage (or a script
  // polling every few seconds) never hits it, but bounded so a single
  // caller can't drive unlimited RPC load through /api/tokens (several
  // chain reads per token) if this is ever reachable from outside
  // localhost. Per IP, sliding window.
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().default(120),
  // Separate, stricter per-IP cap on POST /api/chat — each request can cost a paid LLM call on the server's key.
  CHAT_RATE_LIMIT_WINDOW_MS: z.coerce.number().default(900_000),
  CHAT_RATE_LIMIT_MAX: z.coerce.number().default(20),

  // --- Optional: AI layer (src/ai/) ---
  // Unset by default — every AI feature (natural-language summaries, the
  // chat agent) must degrade to "disabled" or "deterministic fallback"
  // rather than throw when this is empty. See src/ai/client.ts.
  // Never call the AI on raw chain data: only on numbers FLETCH's
  // deterministic engine already computed (src/ai/explain.ts, ai/tools.ts).
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  // Current model catalog: https://docs.claude.com — check there before
  // changing this default, since model names are periodically retired.
  ANTHROPIC_MODEL: z.string().optional().default("claude-sonnet-5"),
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
  trustProxy: env.TRUST_PROXY,
  dbPath: env.DB_PATH,
  enablePoller: env.ENABLE_POLLER,
  pollIntervalMs: env.POLL_INTERVAL_MS,
  pollTokenLimit: env.POLL_TOKEN_LIMIT,
  snapshotMinIntervalSeconds: env.SNAPSHOT_MIN_INTERVAL_SECONDS,
  discoveryIntervalMs: env.DISCOVERY_INTERVAL_MS,
  activitySweepIntervalMs: env.ACTIVITY_SWEEP_INTERVAL_MS,
  maxConcurrentTokens: env.MAX_CONCURRENT_TOKENS,
  maxMonitoredTokens: env.MAX_MONITORED_TOKENS,
  maxConsecutiveFailures: env.MAX_CONSECUTIVE_FAILURES,
  failedReactivateAfterSeconds: env.FAILED_REACTIVATE_AFTER_SECONDS,
  rpcBackoffBaseMs: env.RPC_BACKOFF_BASE_MS,
  rpcBackoffMaxMs: env.RPC_BACKOFF_MAX_MS,
  multicall3Address: (env.MULTICALL3_ADDRESS || undefined) as `0x${string}` | undefined,
  signalRetentionDays: env.SIGNAL_RETENTION_DAYS,
  snapshotRetentionDays: env.SNAPSHOT_RETENTION_DAYS,
  logScanChunkBlocks: BigInt(env.LOG_SCAN_CHUNK_BLOCKS),
  maxHolderScanBlocks: BigInt(env.MAX_HOLDER_SCAN_BLOCKS),
  maxHolderBackfillBlocks: BigInt(env.MAX_HOLDER_BACKFILL_BLOCKS),
  deadLiquidityEth: env.DEAD_LIQUIDITY_ETH,
  deadAfterBlocks: env.DEAD_AFTER_BLOCKS,
  deadRecheckSeconds: env.DEAD_RECHECK_SECONDS,
  rateLimitWindowMs: env.RATE_LIMIT_WINDOW_MS,
  rateLimitMax: env.RATE_LIMIT_MAX,
  chatRateLimitWindowMs: env.CHAT_RATE_LIMIT_WINDOW_MS,
  chatRateLimitMax: env.CHAT_RATE_LIMIT_MAX,
  anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
  anthropicModel: env.ANTHROPIC_MODEL,

  /** True when the AI layer (natural-language summaries, chat agent) has
   *  a key to work with — otherwise those features return their
   *  deterministic/disabled fallback instead of calling out. */
  hasAnthropic(): boolean {
    return !!env.ANTHROPIC_API_KEY;
  },

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
