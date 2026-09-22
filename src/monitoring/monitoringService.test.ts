import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useInMemoryDbForTests } from "../persistence/db.js";
import { recordSnapshot } from "../persistence/snapshots.js";
import { recordSignal } from "../persistence/signalsStore.js";
import {
  runDiscoveryCycle,
  runMonitoringCycle,
  runRetentionCycle,
  computeNextPriority,
  type MonitoringDeps,
} from "./monitoringService.js";
import { getMonitoredToken, upsertDiscovered, getDueForCheck, countMonitored } from "./monitoringStore.js";
import { getSnapshotHistory } from "../persistence/snapshots.js";
import { getSignalsForToken } from "../persistence/signalsStore.js";
import type { DetectedLaunch } from "../chain/hunt.js";
import type { TokenMetrics } from "../data/types.js";
import type { FletchScore } from "../scoring/fletchScore.js";
import type { Signal } from "../signals/types.js";

const NOW = 1_700_000_000;

beforeEach(() => {
  useInMemoryDbForTests();
});

function addr(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
}

function fakeLaunch(token: `0x${string}`, overrides: Partial<DetectedLaunch> = {}): DetectedLaunch {
  return {
    token,
    curve: addr(9_000_000 + Number(BigInt(token) % 1000n)),
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
    ...overrides,
  };
}

function fakeMetrics(overrides: Partial<TokenMetrics> = {}): TokenMetrics {
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
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<MonitoringDeps> = {}): MonitoringDeps {
  return {
    scanLaunches: async () => [],
    getMetrics: async () => fakeMetrics(),
    getSmartMoney: async () => ({ available: false, reason: "test stub" }),
    getSocial: async () => ({ available: false, reason: "test stub" }),
    ...overrides,
  };
}

// ---------- discovery ----------

test("runDiscoveryCycle adds every scanned launch not already in the queue", async () => {
  const launches = [fakeLaunch(addr(1)), fakeLaunch(addr(2))];
  const result = await runDiscoveryCycle(fakeDeps({ scanLaunches: async () => launches }), NOW);
  assert.equal(result.scanned, 2);
  assert.equal(result.discovered, 2);
  assert.equal(countMonitored(), 2);
});

test("runDiscoveryCycle never re-adds an already-known launch — no duplicate rows, no reset state", async () => {
  const launch = fakeLaunch(addr(1));
  await runDiscoveryCycle(fakeDeps({ scanLaunches: async () => [launch] }), NOW);
  const result = await runDiscoveryCycle(fakeDeps({ scanLaunches: async () => [launch] }), NOW + 100);
  assert.equal(result.discovered, 0);
  assert.equal(countMonitored(), 1);
});

test("a newly discovered token stores its launch data for reuse on later checks — never re-derived from raw logs every cycle", async () => {
  const launch = fakeLaunch(addr(1), { devBuyTokens: 12345 });
  await runDiscoveryCycle(fakeDeps({ scanLaunches: async () => [launch] }), NOW);
  const stored = getMonitoredToken(addr(1));
  assert.equal(stored?.launch?.devBuyTokens, 12345);
});

test("runDiscoveryCycle respects MAX_MONITORED_TOKENS — a launch storm can't grow the queue without bound", async () => {
  const cap = 500; // config default
  const launches = Array.from({ length: cap + 5 }, (_, i) => fakeLaunch(addr(i + 1)));
  const result = await runDiscoveryCycle(fakeDeps({ scanLaunches: async () => launches }), NOW);
  assert.equal(result.discovered, cap);
  assert.equal(result.skippedCapacity, 5);
  assert.equal(countMonitored(), cap);
});

// ---------- monitoring cycle: success path ----------

test("a successful check persists a real snapshot through the existing signal engine — no parallel signal system", async () => {
  upsertDiscovered(addr(1), NOW, "HIGH", fakeLaunch(addr(1)));
  const result = await runMonitoringCycle(fakeDeps(), NOW, 5, 10);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 0);
  const history = getSnapshotHistory(addr(1), 1);
  assert.equal(history.length, 1);
  assert.equal(history[0].holderCount, 50); // from fakeMetrics()
});

test("a successful check records phase from metrics.graduated — CURVE and GRADUATED are both stored honestly", async () => {
  upsertDiscovered(addr(1), NOW, "HIGH", fakeLaunch(addr(1)));
  await runMonitoringCycle(fakeDeps({ getMetrics: async () => fakeMetrics({ graduated: true }) }), NOW, 5, 10);
  assert.equal(getMonitoredToken(addr(1))?.phase, "GRADUATED");
});

test("a successful check advances next_check_at so the same token isn't immediately due again", async () => {
  upsertDiscovered(addr(1), NOW, "HIGH", fakeLaunch(addr(1)));
  await runMonitoringCycle(fakeDeps(), NOW, 5, 10);
  const due = getDueForCheck(NOW + 1, 10);
  assert.equal(due.length, 0);
});

// ---------- monitoring cycle: failure path ----------

test("a failed check never writes a snapshot — no fake liquidity/holders/price on RPC failure", async () => {
  upsertDiscovered(addr(1), NOW, "HIGH", fakeLaunch(addr(1)));
  const result = await runMonitoringCycle(
    fakeDeps({
      getMetrics: async () => {
        throw new Error("RPC timeout");
      },
    }),
    NOW,
    5,
    10
  );
  assert.equal(result.failed, 1);
  assert.equal(getSnapshotHistory(addr(1), 1).length, 0);
});

test("a failed check records the real error message on the monitoring row, not a generic one", async () => {
  upsertDiscovered(addr(1), NOW, "HIGH", fakeLaunch(addr(1)));
  await runMonitoringCycle(
    fakeDeps({
      getMetrics: async () => {
        throw new Error("connection refused");
      },
    }),
    NOW,
    5,
    10
  );
  assert.equal(getMonitoredToken(addr(1))?.lastError, "connection refused");
});

test("a token failing repeatedly is marked FAILED and stops being scheduled — no infinite retry", async () => {
  upsertDiscovered(addr(1), NOW, "HIGH", fakeLaunch(addr(1)));
  const failingDeps = fakeDeps({
    getMetrics: async () => {
      throw new Error("dead contract");
    },
  });
  // config default MAX_CONSECUTIVE_FAILURES is 5 — run 5 cycles, each one due immediately after the last (failure retry uses pollIntervalMs, but we pass increasing `now` past that).
  let now = NOW;
  for (let i = 0; i < 5; i++) {
    await runMonitoringCycle(failingDeps, now, 5, 10);
    now += 301; // past the retry interval used on failure (pollIntervalMs/1000 = 300s default)
  }
  assert.equal(getMonitoredToken(addr(1))?.status, "FAILED");
  const due = getDueForCheck(now + 1_000_000, 10);
  assert.equal(due.length, 0);
});

test("one broken token never stops the rest of the batch from being checked", async () => {
  upsertDiscovered(addr(1), NOW, "HIGH", fakeLaunch(addr(1)));
  upsertDiscovered(addr(2), NOW, "HIGH", fakeLaunch(addr(2)));
  const result = await runMonitoringCycle(
    fakeDeps({
      getMetrics: async (t) => {
        if (t === addr(1)) throw new Error("boom");
        return fakeMetrics();
      },
    }),
    NOW,
    5,
    10
  );
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  assert.equal(getSnapshotHistory(addr(2), 1).length, 1);
});

// ---------- priority ----------

test("a brand-new launch is HIGH priority regardless of activity", () => {
  const token = getMonitoredTokenFixture({ firstDetectedAt: NOW, token: addr(1) });
  assert.equal(computeNextPriority(token, NOW + 10), "HIGH");
});

test("an old token with a signal inside the radar-like window is HIGH priority", () => {
  recordSignal(addr(1), fakeSignal({ timestamp: NOW - 100 }));
  const token = getMonitoredTokenFixture({ firstDetectedAt: NOW - 100_000, token: addr(1) });
  assert.equal(computeNextPriority(token, NOW), "HIGH");
});

test("an old token with only a stale signal is NORMAL priority, not HIGH", () => {
  recordSignal(addr(1), fakeSignal({ timestamp: NOW - 100_000 }));
  const token = getMonitoredTokenFixture({ firstDetectedAt: NOW - 200_000, token: addr(1) });
  assert.equal(computeNextPriority(token, NOW), "NORMAL");
});

test("an old, perfectly quiet token (no signals ever) settles to LOW priority", () => {
  const token = getMonitoredTokenFixture({ firstDetectedAt: NOW - 200_000, token: addr(1) });
  assert.equal(computeNextPriority(token, NOW), "LOW");
});

// ---------- retention ----------

test("runRetentionCycle removes snapshots and signals past their configured retention window", () => {
  recordSnapshot(addr(1), fakeMetrics(), fakeScore(), "LOW", NOW - 100 * 86_400); // 100 days old
  recordSignal(addr(1), fakeSignal({ timestamp: NOW - 100 * 86_400 }));
  const result = runRetentionCycle(NOW);
  assert.ok(result.snapshotsRemoved >= 1);
  assert.ok(result.signalsRemoved >= 1);
  assert.equal(getSnapshotHistory(addr(1), 10).length, 0);
  assert.equal(getSignalsForToken(addr(1), 10).length, 0);
});

test("runRetentionCycle never removes recent data", () => {
  recordSnapshot(addr(1), fakeMetrics(), fakeScore(), "LOW", NOW);
  recordSignal(addr(1), fakeSignal({ timestamp: NOW }));
  runRetentionCycle(NOW);
  assert.equal(getSnapshotHistory(addr(1), 10).length, 1);
  assert.equal(getSignalsForToken(addr(1), 10).length, 1);
});

// ---------- helpers for priority tests ----------

function getMonitoredTokenFixture(overrides: { firstDetectedAt: number; token: `0x${string}` }) {
  upsertDiscovered(overrides.token, overrides.firstDetectedAt);
  return getMonitoredToken(overrides.token)!;
}

function fakeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    type: "BUY_PRESSURE",
    severity: "MEDIUM",
    confidence: 80,
    evidence: "e",
    explanation: "x",
    timestamp: NOW,
    ...overrides,
  };
}

function fakeScore(overrides: Partial<FletchScore> = {}): FletchScore {
  return {
    overall: 50,
    components: {
      momentum: { value: 50, label: "" },
      smartMoney: { value: null, label: "", reason: "x" },
      social: { value: null, label: "", reason: "x" },
      liquidity: { value: 50, label: "" },
      holderGrowth: { value: 50, label: "" },
      whaleActivity: { value: 50, label: "" },
      safety: { value: 90, label: "" },
    },
    weightsUsed: {},
    ...overrides,
  };
}
