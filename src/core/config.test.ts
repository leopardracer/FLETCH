import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * core/config.ts parses process.env exactly once, at module import time —
 * by design (fail fast on bad config at boot, not on first use). That
 * makes it a singleton that can't be re-parsed with different inputs in
 * one process the normal way. Each test here forces a genuinely fresh
 * module evaluation with a unique query-string specifier (a standard
 * ESM cache-busting technique), sets process.env immediately before that
 * import, and restores it immediately after — so these tests don't leak
 * env state into each other or into other test files.
 */

const ENV_KEYS = [
  "CHAIN_ID",
  "RPC_URL",
  "BLOCKSCOUT_API_KEY",
  "BLOCKSCOUT_API_BASE",
  "PAIR_ASSET_COINGECKO_ID",
  "SIGNAL_WINDOW_BLOCKS",
  "WHALE_THRESHOLD_TOKENS",
  "PORT",
  "DB_PATH",
  "ENABLE_POLLER",
  "POLL_INTERVAL_MS",
  "POLL_TOKEN_LIMIT",
  "SNAPSHOT_MIN_INTERVAL_SECONDS",
  "DISCOVERY_INTERVAL_MS",
  "MAX_CONCURRENT_TOKENS",
  "MAX_MONITORED_TOKENS",
  "MAX_CONSECUTIVE_FAILURES",
  "SIGNAL_RETENTION_DAYS",
  "SNAPSHOT_RETENTION_DAYS",
  "LOG_SCAN_CHUNK_BLOCKS",
  "MAX_HOLDER_SCAN_BLOCKS",
  "RATE_LIMIT_WINDOW_MS",
  "RATE_LIMIT_MAX",
];

async function freshConfig(overrides: Record<string, string>) {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.DB_PATH = ":memory:"; // never touch a real file from this test
  Object.assign(process.env, overrides);
  try {
    const mod = await import(`./config.js?bust=${Date.now()}_${Math.random()}`);
    return mod.config;
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("ENABLE_POLLER=false (the literal string) parses as false — regression test for the z.coerce.boolean footgun", async () => {
  const c = await freshConfig({ ENABLE_POLLER: "false" });
  assert.equal(c.enablePoller, false);
});

test("ENABLE_POLLER=0 also parses as false", async () => {
  const c = await freshConfig({ ENABLE_POLLER: "0" });
  assert.equal(c.enablePoller, false);
});

test("ENABLE_POLLER=true parses as true, and leaving it unset defaults to true", async () => {
  const explicit = await freshConfig({ ENABLE_POLLER: "true" });
  assert.equal(explicit.enablePoller, true);
  const defaulted = await freshConfig({});
  assert.equal(defaulted.enablePoller, true);
});

test("requireRpcUrl throws a helpful, specific error when RPC_URL is empty", async () => {
  const c = await freshConfig({ RPC_URL: "" });
  assert.throws(() => c.requireRpcUrl(), /RPC_URL is not set/);
});

test("requireRpcUrl returns the configured URL unchanged when one is set", async () => {
  const c = await freshConfig({ RPC_URL: "https://example.invalid/rpc" });
  assert.equal(c.requireRpcUrl(), "https://example.invalid/rpc");
});

test("hasBlockscout is false for an empty key and true once a real key is set", async () => {
  const noKey = await freshConfig({ BLOCKSCOUT_API_KEY: "" });
  assert.equal(noKey.hasBlockscout(), false);
  const withKey = await freshConfig({ BLOCKSCOUT_API_KEY: "abc123" });
  assert.equal(withKey.hasBlockscout(), true);
});

test("numeric env vars coerce to real numbers, and the block-window field becomes a bigint", async () => {
  const c = await freshConfig({ SIGNAL_WINDOW_BLOCKS: "1000", WHALE_THRESHOLD_TOKENS: "500", PORT: "9999" });
  assert.equal(c.signalWindowBlocks, 1000n);
  assert.equal(typeof c.signalWindowBlocks, "bigint");
  assert.equal(c.whaleThresholdTokens, 500);
  assert.equal(c.port, 9999);
});

test("unset numeric fields fall back to their documented defaults, not zero or undefined", async () => {
  const c = await freshConfig({});
  assert.equal(c.chainId, 4663);
  assert.equal(c.port, 8787);
  assert.equal(c.signalWindowBlocks, 50_000n);
});

test("monitoring config has safe, bounded defaults — never zero/unbounded, which could hammer the RPC provider", async () => {
  const c = await freshConfig({});
  assert.ok(c.discoveryIntervalMs >= 60_000);
  assert.ok(c.maxConcurrentTokens > 0 && c.maxConcurrentTokens <= 20);
  assert.ok(c.maxMonitoredTokens > 0);
  assert.ok(c.maxConsecutiveFailures > 0);
  assert.ok(c.signalRetentionDays > 0);
  assert.ok(c.snapshotRetentionDays > 0);
});

test("rate limit config defaults to a bounded, local-dev-safe window and cap, and coerces from env strings", async () => {
  const defaulted = await freshConfig({});
  assert.ok(defaulted.rateLimitWindowMs > 0);
  assert.ok(defaulted.rateLimitMax > 0 && defaulted.rateLimitMax < 10_000); // never accidentally unbounded
  const overridden = await freshConfig({ RATE_LIMIT_WINDOW_MS: "1000", RATE_LIMIT_MAX: "5" });
  assert.equal(overridden.rateLimitWindowMs, 1000);
  assert.equal(overridden.rateLimitMax, 5);
});

test("monitoring config values coerce from env strings to real numbers", async () => {
  const c = await freshConfig({ MAX_CONCURRENT_TOKENS: "3", MAX_MONITORED_TOKENS: "50", SIGNAL_RETENTION_DAYS: "7" });
  assert.equal(c.maxConcurrentTokens, 3);
  assert.equal(c.maxMonitoredTokens, 50);
  assert.equal(c.signalRetentionDays, 7);
});

test("log-scan bounds have safe, non-zero defaults — never unbounded, which could re-trigger the exact wide-range RPC rejection this was built to fix", async () => {
  const c = await freshConfig({});
  assert.ok(c.logScanChunkBlocks > 0n);
  assert.ok(c.maxHolderScanBlocks > 0n);
  assert.ok(c.maxHolderScanBlocks >= c.logScanChunkBlocks, "the cap should allow at least one full chunk");
});

test("log-scan bounds coerce from env strings to real bigints", async () => {
  const c = await freshConfig({ LOG_SCAN_CHUNK_BLOCKS: "500", MAX_HOLDER_SCAN_BLOCKS: "5000" });
  assert.equal(c.logScanChunkBlocks, 500n);
  assert.equal(c.maxHolderScanBlocks, 5000n);
});
