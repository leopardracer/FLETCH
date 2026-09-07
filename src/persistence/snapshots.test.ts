import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useInMemoryDbForTests } from "./db.js";
import { recordSnapshot, getPreviousSnapshot, getSnapshotHistory, getLatestSnapshot } from "./snapshots.js";
import type { TokenMetrics } from "../data/types.js";
import type { FletchScore } from "../scoring/fletchScore.js";

const TOKEN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const OTHER_TOKEN = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const NOW = 1_700_000_000;

// Fresh in-memory database before every test — no test in this file touches
// disk, and no test can see another test's rows.
beforeEach(() => {
  useInMemoryDbForTests();
});

function metrics(overrides: Partial<TokenMetrics> = {}): TokenMetrics {
  return {
    priceInPair: 1,
    liquidityPairAsset: 5,
    liquidityUsd: 10_000,
    holderCount: 50,
    holderCountIsLifetime: true,
    buyCountWindow: 10,
    sellCountWindow: 2,
    volumePairAssetWindow: 3,
    topHolderConcentrationPercent: 20,
    whaleMoves: [],
    ...overrides,
  };
}

function score(overallOverride: number | null = 80): FletchScore {
  return {
    overall: overallOverride,
    components: {
      momentum: { value: 90, label: "" },
      smartMoney: { value: null, label: "", reason: "unavailable" },
      social: { value: null, label: "", reason: "unavailable" },
      liquidity: { value: 70, label: "" },
      holderGrowth: { value: 60, label: "" },
      whaleActivity: { value: 50, label: "" },
      safety: { value: 100, label: "" },
    },
    weightsUsed: {},
  };
}

test("a brand-new token has no previous snapshot", () => {
  const prev = getPreviousSnapshot(TOKEN, 600, NOW);
  assert.equal(prev, null);
});

test("a recorded snapshot becomes retrievable as the previous snapshot once enough time has passed", () => {
  recordSnapshot(TOKEN, metrics(), score(), "LOW", NOW - 700);
  const prev = getPreviousSnapshot(TOKEN, 600, NOW);
  assert.ok(prev);
  assert.equal(prev!.holderCount, 50);
  assert.equal(prev!.fletchScore, 80);
});

test("a snapshot inside the comparison window is not returned as 'previous' — avoids comparing against itself", () => {
  recordSnapshot(TOKEN, metrics(), score(), "LOW", NOW - 100); // only 100s ago, window is 600s
  const prev = getPreviousSnapshot(TOKEN, 600, NOW);
  assert.equal(prev, null);
});

test("rate limiting: a second snapshot inside SNAPSHOT_MIN_INTERVAL_SECONDS of the first is silently dropped", () => {
  recordSnapshot(TOKEN, metrics({ holderCount: 50 }), score(), "LOW", NOW);
  recordSnapshot(TOKEN, metrics({ holderCount: 999 }), score(), "LOW", NOW + 5); // default min interval is 60s
  const history = getSnapshotHistory(TOKEN, 10);
  assert.equal(history.length, 1);
  assert.equal(history[0].holderCount, 50); // the second call never wrote
});

test("a snapshot recorded after the rate-limit window is accepted", () => {
  recordSnapshot(TOKEN, metrics({ holderCount: 50 }), score(), "LOW", NOW);
  recordSnapshot(TOKEN, metrics({ holderCount: 75 }), score(), "LOW", NOW + 61);
  const history = getSnapshotHistory(TOKEN, 10);
  assert.equal(history.length, 2);
});

test("snapshot history is ordered most-recent-first", () => {
  recordSnapshot(TOKEN, metrics({ holderCount: 10 }), score(), "LOW", NOW);
  recordSnapshot(TOKEN, metrics({ holderCount: 20 }), score(), "LOW", NOW + 100);
  recordSnapshot(TOKEN, metrics({ holderCount: 30 }), score(), "LOW", NOW + 200);
  const history = getSnapshotHistory(TOKEN, 10);
  assert.deepEqual(history.map((h) => h.holderCount), [30, 20, 10]);
});

test("snapshots for different tokens never leak into each other's history", () => {
  recordSnapshot(TOKEN, metrics({ holderCount: 10 }), score(), "LOW", NOW);
  recordSnapshot(OTHER_TOKEN, metrics({ holderCount: 999 }), score(), "LOW", NOW);
  const history = getSnapshotHistory(TOKEN, 10);
  assert.equal(history.length, 1);
  assert.equal(history[0].holderCount, 10);
});

test("getSnapshotHistory respects the limit parameter", () => {
  for (let i = 0; i < 5; i++) {
    recordSnapshot(TOKEN, metrics({ holderCount: i }), score(), "LOW", NOW + i * 61);
  }
  const history = getSnapshotHistory(TOKEN, 2);
  assert.equal(history.length, 2);
});

test("a null score.overall (no components available) is stored and read back as null, not coerced to 0", () => {
  recordSnapshot(TOKEN, metrics(), score(null), "LOW", NOW);
  const history = getSnapshotHistory(TOKEN, 1);
  assert.equal(history[0].fletchScore, null);
});

test("getLatestSnapshot returns null for a token that's never been checked", () => {
  assert.equal(getLatestSnapshot(TOKEN), null);
});

test("getLatestSnapshot returns the most recent snapshot regardless of age — unlike getPreviousSnapshot, it has no window cutoff", () => {
  recordSnapshot(TOKEN, metrics({ holderCount: 10 }), score(), "LOW", NOW);
  recordSnapshot(TOKEN, metrics({ holderCount: 40 }), score(), "HIGH", NOW + 100);
  const latest = getLatestSnapshot(TOKEN);
  assert.equal(latest?.holderCount, 40);
  assert.equal(latest?.riskLevel, "HIGH");
});

test("riskLevel round-trips exactly as recorded — this is what Meme Radar reads without a live chain call", () => {
  recordSnapshot(TOKEN, metrics(), score(), "CRITICAL", NOW);
  const latest = getLatestSnapshot(TOKEN);
  assert.equal(latest?.riskLevel, "CRITICAL");
});
