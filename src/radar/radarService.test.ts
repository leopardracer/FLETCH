import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useInMemoryDbForTests } from "../persistence/db.js";
import { recordSignal } from "../persistence/signalsStore.js";
import { recordSnapshot } from "../persistence/snapshots.js";
import { getRadar } from "./radarService.js";
import type { Signal } from "../signals/types.js";
import type { TokenMetrics } from "../data/types.js";
import type { FletchScore } from "../scoring/fletchScore.js";

/**
 * Integration tests: persisted signals + snapshots -> ranked Radar
 * entries, through the real getRadar() every real code path (the API)
 * calls. No live RPC needed for ranking — only symbol/name resolution
 * touches the chain client, and that's wrapped in .catch(() => null) the
 * same way the rest of the app degrades without RPC_URL, so these run
 * fully offline against an in-memory database.
 */

const TOKEN_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const TOKEN_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const NOW = 1_700_000_000;

beforeEach(() => {
  useInMemoryDbForTests();
});

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    type: "BUY_PRESSURE",
    severity: "MEDIUM",
    confidence: 100,
    evidence: "e",
    explanation: "Buy activity is outweighing sell activity.",
    timestamp: NOW,
    ...overrides,
  };
}

function metrics(overrides: Partial<TokenMetrics> = {}): TokenMetrics {
  return {
    priceInPair: 1,
    liquidityPairAsset: 5,
    liquidityUsd: 25_000,
    holderCount: 120,
    holderCountIsLifetime: true,
    buyCountWindow: 8,
    sellCountWindow: 1,
    volumePairAssetWindow: 2,
    topHolderConcentrationPercent: 18,
    whaleMoves: [],
    ...overrides,
  };
}

const CLEAN_SCORE: FletchScore = {
  overall: 77,
  components: {
    momentum: { value: 80, label: "" },
    smartMoney: { value: null, label: "", reason: "x" },
    social: { value: null, label: "", reason: "x" },
    liquidity: { value: 70, label: "" },
    holderGrowth: { value: 75, label: "" },
    whaleActivity: { value: 60, label: "" },
    safety: { value: 90, label: "" },
  },
  weightsUsed: {},
};

test("a token with no recent signals never appears on radar", async () => {
  const radar = await getRadar(1800, NOW);
  assert.deepEqual(radar, []);
});

test("a token with a real recent signal appears, ranked, with a real radarScore", async () => {
  recordSignal(TOKEN_A, signal({ timestamp: NOW }));
  const radar = await getRadar(1800, NOW);
  assert.equal(radar.length, 1);
  assert.equal(radar[0].token, TOKEN_A);
  assert.ok(radar[0].radarScore > 0);
});

test("results are sorted by radarScore descending — the more urgent token first", async () => {
  recordSignal(TOKEN_A, signal({ severity: "LOW", timestamp: NOW }));
  recordSignal(TOKEN_B, signal({ severity: "CRITICAL", timestamp: NOW }));
  const radar = await getRadar(1800, NOW);
  assert.equal(radar[0].token, TOKEN_B);
  assert.equal(radar[1].token, TOKEN_A);
});

test("fletchScore and riskLevel come from the token's latest persisted snapshot, not a live call", async () => {
  recordSignal(TOKEN_A, signal({ timestamp: NOW }));
  recordSnapshot(TOKEN_A, metrics(), CLEAN_SCORE, "HIGH", NOW);
  const radar = await getRadar(1800, NOW);
  assert.equal(radar[0].fletchScore, 77);
  assert.equal(radar[0].riskLevel, "HIGH");
  assert.equal(radar[0].metrics.holderCount, 120);
  assert.equal(radar[0].metrics.liquidityUsd, 25_000);
});

test("a token with signals but no snapshot yet still appears — fletchScore/riskLevel are null, not fabricated", async () => {
  recordSignal(TOKEN_A, signal({ timestamp: NOW }));
  const radar = await getRadar(1800, NOW);
  assert.equal(radar[0].fletchScore, null);
  assert.equal(radar[0].riskLevel, null);
  assert.equal(radar[0].dataAvailability.fletchScore, "NOT_ENOUGH_HISTORY");
});

test("whyNow contains the real signal explanations, matching the token's own contributions", async () => {
  recordSignal(TOKEN_A, signal({ type: "BUY_PRESSURE", explanation: "Buy activity is outweighing sell activity.", timestamp: NOW }));
  recordSignal(TOKEN_A, signal({ type: "HOLDER_GROWTH", explanation: "Holder count increased since the last check.", timestamp: NOW }));
  const radar = await getRadar(1800, NOW);
  assert.equal(radar[0].whyNow.length, 2);
  assert.ok(radar[0].whyNow.includes("Buy activity is outweighing sell activity."));
});

test("without RPC_URL configured, symbol/name degrade to null instead of throwing — dataAvailability says so honestly", async () => {
  recordSignal(TOKEN_A, signal({ timestamp: NOW }));
  const radar = await getRadar(1800, NOW);
  assert.equal(radar[0].symbol, null);
  assert.equal(radar[0].dataAvailability.symbol, "UNAVAILABLE");
});

test("a token whose only signal is outside the requested window is excluded from the result", async () => {
  recordSignal(TOKEN_A, signal({ timestamp: NOW - 7200 })); // 2h ago
  const radar = await getRadar(1800, NOW); // 30 min window
  assert.deepEqual(radar, []);
});

test("multiple tokens with real activity each get their own independent radar entry", async () => {
  recordSignal(TOKEN_A, signal({ timestamp: NOW }));
  recordSignal(TOKEN_B, signal({ type: "WHALE_BUY_FROM_CURVE", timestamp: NOW }));
  const radar = await getRadar(1800, NOW);
  assert.equal(radar.length, 2);
  assert.equal(new Set(radar.map((r) => r.token)).size, 2);
});
