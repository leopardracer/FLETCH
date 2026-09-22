import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useInMemoryDbForTests } from "../persistence/db.js";
import { runDiscoveryCycle, runMonitoringCycle, type MonitoringDeps } from "./monitoringService.js";
import { upsertDiscovered, getMonitoredToken, recordCheckFailure, reactivateFailed, getDueForCheck } from "./monitoringStore.js";
import { RpcBackoff } from "../core/rpcBackoff.js";
import type { TokenMetrics } from "../data/types.js";

const NOW = 1_700_000_000;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const rateLimited = () => Object.assign(new Error("HTTP request failed."), { details: "Too Many Requests", status: 429 });
const dailyQuota = () => Object.assign(new Error("Transaction creation failed."), { details: "daily request limit reached - upgrade your account" });

const metrics: TokenMetrics = {
  priceInPair: 1, liquidityPairAsset: 5, liquidityUsd: 20_000, holderCount: 50, holderCountIsLifetime: true,
  buyCountWindow: 5, sellCountWindow: 1, volumePairAssetWindow: 2, topHolderConcentrationPercent: 20, whaleMoves: [], graduated: false,
};

function deps(over: Partial<MonitoringDeps> = {}): MonitoringDeps {
  return {
    scanLaunches: async () => [],
    getMetrics: async () => metrics,
    getSmartMoney: async () => ({ available: false, reason: "stub" }),
    getSocial: async () => ({ available: false, reason: "stub" }),
    ...over,
  };
}

beforeEach(() => {
  useInMemoryDbForTests();
});

test("REGRESSION: a rate-limited check never counts against the token — no failure count, no FAILED", async () => {
  for (let i = 1; i <= 3; i++) upsertDiscovered(addr(i), NOW, "HIGH");
  const backoff = new RpcBackoff(60, 3600);
  const result = await runMonitoringCycle(deps({ getMetrics: async () => { throw rateLimited(); } }), NOW, 1, 20, backoff);
  assert.equal(result.rateLimited, 1);
  assert.equal(result.rateLimitStarted, true);
  assert.equal(result.failed, 0);
  for (let i = 1; i <= 3; i++) {
    const t = getMonitoredToken(addr(i))!;
    assert.equal(t.failureCount, 0);
    assert.equal(t.status, "ACTIVE");
  }
});

test("REGRESSION: after the first rate limit, the rest of the batch isn't fired at a dead provider", async () => {
  for (let i = 1; i <= 20; i++) upsertDiscovered(addr(i), NOW, "HIGH");
  let calls = 0;
  const backoff = new RpcBackoff(60, 3600);
  const result = await runMonitoringCycle(
    deps({ getMetrics: async () => { calls++; throw dailyQuota(); } }),
    NOW, 1, 20, backoff
  );
  assert.equal(calls, 1); // not 20
  assert.equal(result.skippedPaused, 19);
  assert.equal(result.checked, 1);
});

test("while paused, a whole cycle is a no-op — nothing checked, nothing touched", async () => {
  upsertDiscovered(addr(1), NOW, "HIGH");
  const backoff = new RpcBackoff(60, 3600);
  backoff.recordRateLimit(NOW, rateLimited());
  let calls = 0;
  const result = await runMonitoringCycle(deps({ getMetrics: async () => { calls++; return metrics; } }), NOW + 10, 5, 20, backoff);
  assert.equal(calls, 0);
  assert.equal(result.checked, 0);
  assert.equal(getMonitoredToken(addr(1))!.lastCheckedAt, null);
});

test("a rate-limited token is rescheduled for when the pause ends, and checks resume after it", async () => {
  upsertDiscovered(addr(1), NOW, "HIGH");
  const backoff = new RpcBackoff(60, 3600);
  await runMonitoringCycle(deps({ getMetrics: async () => { throw rateLimited(); } }), NOW, 1, 20, backoff);
  assert.equal(getMonitoredToken(addr(1))!.nextCheckAt, NOW + 60);

  const after = await runMonitoringCycle(deps(), NOW + 60, 1, 20, backoff);
  assert.equal(after.succeeded, 1);
  assert.equal(backoff.isPaused(NOW + 60), false);
});

test("real per-token failures still count exactly as before", async () => {
  upsertDiscovered(addr(1), NOW, "HIGH");
  const backoff = new RpcBackoff(60, 3600);
  const result = await runMonitoringCycle(deps({ getMetrics: async () => { throw new Error("execution reverted"); } }), NOW, 1, 20, backoff);
  assert.equal(result.failed, 1);
  assert.equal(result.rateLimited, 0);
  assert.equal(getMonitoredToken(addr(1))!.failureCount, 1);
  assert.equal(backoff.isPaused(NOW), false);
});

test("discovery hitting a rate limit opens the pause instead of throwing, and later ticks skip the scan", async () => {
  const backoff = new RpcBackoff(60, 3600);
  const first = await runDiscoveryCycle(deps({ scanLaunches: async () => { throw rateLimited(); } }), NOW, backoff);
  assert.equal(first.paused, true);
  assert.equal(first.rateLimitStarted, true);
  let scans = 0;
  const second = await runDiscoveryCycle(deps({ scanLaunches: async () => { scans++; return []; } }), NOW + 5, backoff);
  assert.equal(scans, 0);
  assert.equal(second.paused, true);
  assert.equal(second.rateLimitStarted, false);
});

test("discovery still throws on a non-rate-limit error — no masking real bugs", async () => {
  const backoff = new RpcBackoff(60, 3600);
  await assert.rejects(runDiscoveryCycle(deps({ scanLaunches: async () => { throw new Error("boom"); } }), NOW, backoff), /boom/);
});

// ---------- FAILED reactivation ----------

function markFailed(token: `0x${string}`, at: number): void {
  upsertDiscovered(token, at, "HIGH");
  for (let i = 0; i < 5; i++) recordCheckFailure(token, "execution reverted", at, at + 300, 5);
}

test("a FAILED token is reactivated with a fresh retry budget once its cool-off has passed", () => {
  markFailed(addr(1), NOW);
  assert.equal(getMonitoredToken(addr(1))!.status, "FAILED");
  assert.equal(reactivateFailed(NOW + 3600, 21_600), 0); // too soon
  assert.equal(reactivateFailed(NOW + 21_600, 21_600), 1);
  const t = getMonitoredToken(addr(1))!;
  assert.equal(t.status, "ACTIVE");
  assert.equal(t.failureCount, 0);
  assert.equal(getDueForCheck(NOW + 21_600, 10).length, 1);
});

test("reactivation is bounded: a still-broken token goes back to FAILED after the same retry budget", () => {
  markFailed(addr(1), NOW);
  reactivateFailed(NOW + 21_600, 21_600);
  for (let i = 0; i < 5; i++) recordCheckFailure(addr(1), "execution reverted", NOW + 21_600, NOW + 21_900, 5);
  assert.equal(getMonitoredToken(addr(1))!.status, "FAILED");
});

test("cool-off 0 disables reactivation entirely", () => {
  markFailed(addr(1), NOW);
  assert.equal(reactivateFailed(NOW + 10_000_000, 0), 0);
  assert.equal(getMonitoredToken(addr(1))!.status, "FAILED");
});

test("the monitoring cycle runs reactivation itself — no restart needed", async () => {
  markFailed(addr(1), NOW);
  const backoff = new RpcBackoff(60, 3600);
  const result = await runMonitoringCycle(deps(), NOW + 21_600, 5, 20, backoff);
  assert.equal(result.reactivated, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(getMonitoredToken(addr(1))!.status, "ACTIVE");
});
