import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useInMemoryDbForTests } from "../persistence/db.js";
import { runMonitoringCycle, runDiscoveryCycle, type MonitoringDeps } from "./monitoringService.js";
import { upsertDiscovered, countMonitored } from "./monitoringStore.js";
import type { DetectedLaunch } from "../chain/hunt.js";
import type { TokenMetrics } from "../data/types.js";

/**
 * A deterministic stress test for the scheduler, not a benchmark claim.
 * This measures three things the brief explicitly asks for — scheduled
 * job count, maximum concurrency, and duplicate work — at 100 and 1,000
 * monitored tokens, using an in-memory database and a fake provider with
 * an artificial delay (so overlapping work is actually observable). It
 * does NOT claim FLETCH "supports" 10,000 tokens — that would need a real
 * benchmark against real RPC latency, which this repo doesn't have.
 */

const NOW = 1_700_000_000;

beforeEach(() => {
  useInMemoryDbForTests();
});

function addr(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
}

function fakeLaunch(token: `0x${string}`): DetectedLaunch {
  return {
    token,
    curve: addr(9_000_000),
    deployer: addr(8_000_000),
    pairToken: "0x0000000000000000000000000000000000000000",
    graduationThreshold: 1_000_000n,
    launchBlock: 100n,
    launchTxHash: "0xabc",
    devBuyTokens: 0,
    devBuyTaxBps: 9900,
    exemptWalletCount: 0,
    deployerLaunchCountInWindow: 1,
    launchTimestamp: null,
  };
}

function fakeMetrics(): TokenMetrics {
  return {
    priceInPair: 1,
    liquidityPairAsset: 5,
    liquidityUsd: 20_000,
    holderCount: 50,
    holderCountIsLifetime: true,
    buyCountWindow: 5,
    sellCountWindow: 1,
    volumePairAssetWindow: 2,
    topHolderConcentrationPercent: 20,
    whaleMoves: [],
    graduated: false,
  };
}

/** A small artificial delay makes overlapping calls actually observable —
 *  without it, a broken "concurrency limit" that's really unbounded could
 *  still look fine because everything resolves synchronously fast. */
function countingDeps(delayMs: number): { deps: MonitoringDeps; callCounts: Map<string, number> } {
  const callCounts = new Map<string, number>();
  const deps: MonitoringDeps = {
    scanLaunches: async () => [],
    getMetrics: async (t) => {
      callCounts.set(t, (callCounts.get(t) ?? 0) + 1);
      await new Promise((r) => setTimeout(r, delayMs));
      return fakeMetrics();
    },
    getSmartMoney: async () => ({ available: false, reason: "test stub" }),
    getSocial: async () => ({ available: false, reason: "test stub" }),
  };
  return { deps, callCounts };
}

async function seedMonitoredTokens(count: number) {
  for (let i = 1; i <= count; i++) {
    upsertDiscovered(addr(i), NOW, "HIGH", fakeLaunch(addr(i)));
  }
}

test("stress: 100 monitored tokens — concurrency stays at the configured limit, every token checked exactly once, no duplicate work", async () => {
  await seedMonitoredTokens(100);
  const { deps, callCounts } = countingDeps(2);
  const concurrency = 5;

  const result = await runMonitoringCycle(deps, NOW, concurrency, 100);

  assert.equal(result.checked, 100);
  assert.equal(result.succeeded, 100);
  assert.equal(result.maxConcurrencyObserved, concurrency, "concurrency should reach exactly the configured limit with 100 tokens queued");
  assert.equal(callCounts.size, 100, "every token should have been called exactly once each — no duplicates, none skipped");
  for (const count of callCounts.values()) assert.equal(count, 1);
});

test("stress: 1,000 monitored tokens — the queue and concurrency bound both hold at 10x scale", async () => {
  await seedMonitoredTokens(1000);
  const { deps, callCounts } = countingDeps(1);
  const concurrency = 8;

  const start = Date.now();
  const result = await runMonitoringCycle(deps, NOW, concurrency, 1000);
  const elapsedMs = Date.now() - start;

  assert.equal(result.checked, 1000);
  assert.equal(result.succeeded, 1000);
  assert.equal(result.maxConcurrencyObserved, concurrency);
  assert.equal(callCounts.size, 1000);
  // Bounded concurrency means wall time is roughly (n/concurrency) * delay,
  // not n * delay — a real (if loose) signal that work is actually
  // parallelized rather than silently serialized. 1000/8*1ms ~= 125ms;
  // 1000*1ms serial would be ~1000ms. Generous ceiling to avoid CI flakiness.
  assert.ok(elapsedMs < 900, `expected well under fully-serial time (~1000ms), got ${elapsedMs}ms`);
});

test("stress: discovery with 1,000 unique launches at once is bounded by MAX_MONITORED_TOKENS, not left to grow unbounded", async () => {
  const launches = Array.from({ length: 1000 }, (_, i) => fakeLaunch(addr(i + 1)));
  const result = await runDiscoveryCycle({ scanLaunches: async () => launches, getMetrics: async () => fakeMetrics(), getSmartMoney: async () => ({ available: false, reason: "x" }), getSocial: async () => ({ available: false, reason: "x" }) }, NOW);
  assert.equal(result.scanned, 1000);
  assert.ok(result.discovered <= 500, "should stop discovering at the configured MAX_MONITORED_TOKENS cap (default 500)");
  assert.equal(result.discovered + result.skippedCapacity, 1000);
  assert.equal(countMonitored(), result.discovered);
});
