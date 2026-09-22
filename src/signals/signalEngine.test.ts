import { test } from "node:test";
import assert from "node:assert/strict";
import { detectSignals } from "./signalEngine.js";
import type { TokenMetrics } from "../data/types.js";
import type { RiskReport } from "../risk/riskAnalysis.js";
import type { TokenSnapshot } from "../persistence/snapshots.js";

const NOW = 1_700_000_000;
const CURVE = "0xcccccccccccccccccccccccccccccccccccccccc" as const;

function metrics(overrides: Partial<TokenMetrics> = {}): TokenMetrics {
  return {
    priceInPair: null,
    liquidityPairAsset: null,
    liquidityUsd: null,
    holderCount: null,
    holderCountIsLifetime: false,
    buyCountWindow: 0,
    sellCountWindow: 0,
    volumePairAssetWindow: null,
    topHolderConcentrationPercent: null,
    whaleMoves: [],
    graduated: null,
    ...overrides,
  };
}

const CLEAN_RISK: RiskReport = { level: "LOW", findings: [{ level: "LOW", code: "CLEAN", evidence: "no red flags" }], safetyScore: 100 };

function snapshot(overrides: Partial<TokenSnapshot> = {}): TokenSnapshot {
  return {
    takenAt: NOW - 600,
    priceInPair: null,
    liquidityUsd: null,
    holderCount: null,
    buyCountWindow: 0,
    sellCountWindow: 0,
    volumePairAssetWindow: null,
    topHolderConcentrationPercent: null,
    fletchScore: null,
    momentumScore: null,
    liquidityScore: null,
    holderGrowthScore: null,
    whaleActivityScore: null,
    safetyScore: null,
    riskLevel: null,
    graduated: null,
    ...overrides,
  };
}

test("no signals fire from an empty, quiet token — never invents activity", () => {
  const signals = detectSignals({ metrics: metrics(), risk: CLEAN_RISK, previousSnapshot: null, now: NOW });
  assert.deepEqual(signals, []);
});

test("buy pressure only fires with a minimum sample size — a single trade isn't a signal", () => {
  const oneTradeOnly = detectSignals({ metrics: metrics({ buyCountWindow: 1, sellCountWindow: 0 }), risk: CLEAN_RISK, previousSnapshot: null, now: NOW });
  assert.equal(oneTradeOnly.filter((s) => s.type === "BUY_PRESSURE").length, 0);

  const enoughSample = detectSignals({ metrics: metrics({ buyCountWindow: 9, sellCountWindow: 1 }), risk: CLEAN_RISK, previousSnapshot: null, now: NOW });
  const buy = enoughSample.find((s) => s.type === "BUY_PRESSURE");
  assert.ok(buy);
  assert.equal(buy!.severity, "HIGH");
  assert.match(buy!.evidence, /9 buys vs 1 sells/);
});

test("whale move through the curve is classified by direction only when curveAddress is known", () => {
  const move = { from: CURVE, to: "0x1111111111111111111111111111111111111111" as const, amount: 5000, txHash: "0xabc" as const, blockNumber: 1n };

  const withCurve = detectSignals({ metrics: metrics({ whaleMoves: [move] }), risk: CLEAN_RISK, curveAddress: CURVE, previousSnapshot: null, now: NOW });
  assert.equal(withCurve.find((s) => s.type === "WHALE_BUY_FROM_CURVE")?.evidence.includes("5,000"), true);

  const withoutCurve = detectSignals({ metrics: metrics({ whaleMoves: [move] }), risk: CLEAN_RISK, previousSnapshot: null, now: NOW });
  assert.equal(withoutCurve.some((s) => s.type === "WHALE_BUY_FROM_CURVE"), false);
  assert.equal(withoutCurve.some((s) => s.type === "WHALE_TRANSFER"), true);
});

test("risk findings above LOW are promoted to signals with the exact same evidence text", () => {
  const risk: RiskReport = {
    level: "HIGH",
    findings: [
      { level: "LOW", code: "CLEAN", evidence: "no red flags" },
      { level: "HIGH", code: "HOLDER_CONCENTRATION", evidence: "top 10 holders own 61%" },
    ],
    safetyScore: 40,
  };
  const signals = detectSignals({ metrics: metrics(), risk, previousSnapshot: null, now: NOW });
  const concentration = signals.find((s) => s.type === "HOLDER_CONCENTRATION");
  assert.ok(concentration);
  assert.equal(concentration!.evidence, "top 10 holders own 61%");
  assert.equal(signals.some((s) => s.evidence === "no red flags"), false); // CLEAN never becomes a signal
});

test("trend signals never fire without a previous snapshot", () => {
  const signals = detectSignals({ metrics: metrics({ holderCount: 500, liquidityUsd: 50_000 }), risk: CLEAN_RISK, previousSnapshot: null, now: NOW });
  assert.equal(signals.some((s) => s.type === "HOLDER_GROWTH" || s.type === "LIQUIDITY_INCREASE"), false);
});

test("holder growth signal states the real before/after counts and percentage", () => {
  const prev = snapshot({ holderCount: 100, takenAt: NOW - 600 });
  const signals = detectSignals({
    metrics: metrics({ holderCount: 142 }),
    risk: CLEAN_RISK,
    previousSnapshot: prev,
    now: NOW,
  });
  const growth = signals.find((s) => s.type === "HOLDER_GROWTH");
  assert.ok(growth);
  assert.match(growth!.evidence, /100 → 142 \(\+42\.0%\)/);
  assert.equal(growth!.severity, "HIGH"); // 42% >= 20% threshold
});

test("holder decline is a distinct signal type from growth, not a negative growth value", () => {
  const prev = snapshot({ holderCount: 200, takenAt: NOW - 600 });
  const signals = detectSignals({ metrics: metrics({ holderCount: 150 }), risk: CLEAN_RISK, previousSnapshot: prev, now: NOW });
  assert.ok(signals.find((s) => s.type === "HOLDER_DECLINE"));
  assert.equal(signals.some((s) => s.type === "HOLDER_GROWTH"), false);
});

test("liquidity change signal requires at least a 10% move to avoid noise", () => {
  const prev = snapshot({ liquidityUsd: 10_000, takenAt: NOW - 600 });
  const tinyMove = detectSignals({ metrics: metrics({ liquidityUsd: 10_300 }), risk: CLEAN_RISK, previousSnapshot: prev, now: NOW });
  assert.equal(tinyMove.some((s) => s.type === "LIQUIDITY_INCREASE"), false);

  const realMove = detectSignals({ metrics: metrics({ liquidityUsd: 13_000 }), risk: CLEAN_RISK, previousSnapshot: prev, now: NOW });
  assert.ok(realMove.find((s) => s.type === "LIQUIDITY_INCREASE"));
});

test("price movement requires at least a 5% move, and severity scales with the size of the move", () => {
  const prev = snapshot({ priceInPair: 1.0, takenAt: NOW - 600 });

  const tinyMove = detectSignals({ metrics: metrics({ priceInPair: 1.02 }), risk: CLEAN_RISK, previousSnapshot: prev, now: NOW }); // +2%
  assert.equal(tinyMove.some((s) => s.type === "PRICE_UP" || s.type === "PRICE_DOWN"), false);

  const moderateUp = detectSignals({ metrics: metrics({ priceInPair: 1.10 }), risk: CLEAN_RISK, previousSnapshot: prev, now: NOW }); // +10%
  const up = moderateUp.find((s) => s.type === "PRICE_UP");
  assert.ok(up);
  assert.equal(up!.severity, "MEDIUM");
  assert.match(up!.evidence, /price \+10\.0% over 10m/);

  const bigDrop = detectSignals({ metrics: metrics({ priceInPair: 0.75 }), risk: CLEAN_RISK, previousSnapshot: prev, now: NOW }); // -25%
  const down = bigDrop.find((s) => s.type === "PRICE_DOWN");
  assert.ok(down);
  assert.equal(down!.severity, "HIGH"); // |pct| >= 20%
  assert.match(down!.evidence, /price -25\.0% over 10m/);
  assert.equal(bigDrop.some((s) => s.type === "PRICE_UP"), false, "a price drop must never also register as PRICE_UP");
});

test("price movement never fires when the previous price was zero — avoids a division by zero producing a fake percentage", () => {
  const prev = snapshot({ priceInPair: 0, takenAt: NOW - 600 });
  const signals = detectSignals({ metrics: metrics({ priceInPair: 5 }), risk: CLEAN_RISK, previousSnapshot: prev, now: NOW });
  assert.equal(signals.some((s) => s.type === "PRICE_UP" || s.type === "PRICE_DOWN"), false);
});

test("activity acceleration reports a real trades-per-minute rate derived from the two snapshots", () => {
  const prev = snapshot({ buyCountWindow: 10, sellCountWindow: 5, takenAt: NOW - 600 }); // 10 min earlier
  const signals = detectSignals({
    metrics: metrics({ buyCountWindow: 40, sellCountWindow: 10 }), // +35 trades over 10 min = 3.5/min
    risk: CLEAN_RISK,
    previousSnapshot: prev,
    now: NOW,
  });
  const accel = signals.find((s) => s.type === "ACTIVITY_ACCELERATION");
  assert.ok(accel);
  assert.match(accel!.evidence, /35 trades in the last 10m \(3\.5\/min\)/);
});

test("REGRESSION: a young token (launched under an hour ago) never gets a baseline comparison, even with history — young-token fallback stays exactly as before", () => {
  const prev = snapshot({ buyCountWindow: 10, sellCountWindow: 5, takenAt: NOW - 600 });
  const history = [
    snapshot({ buyCountWindow: 0, sellCountWindow: 0, takenAt: NOW - 1800 }),
    snapshot({ buyCountWindow: 5, sellCountWindow: 2, takenAt: NOW - 1200 }),
    prev,
  ];
  const signals = detectSignals({
    metrics: metrics({ buyCountWindow: 40, sellCountWindow: 10 }),
    risk: CLEAN_RISK,
    previousSnapshot: prev,
    launchTimestamp: NOW - 1800, // 30 minutes old — under MIN_LAUNCH_AGE_FOR_BASELINE_SECONDS (1h)
    snapshotHistory: history,
    now: NOW,
  });
  const accel = signals.find((s) => s.type === "ACTIVITY_ACCELERATION");
  assert.ok(accel);
  // Fixed-threshold evidence format, not the baseline-comparison one
  assert.match(accel!.evidence, /35 trades in the last 10m \(3\.5\/min\)$/);
  assert.doesNotMatch(accel!.evidence, /lifetime average/);
});

test("a mature, well-observed token compares against its own real lifetime average instead of a fixed threshold", () => {
  // Lifetime history: 0 -> 6 -> 12 trades over 120 min = exactly 0.10/min baseline
  const history = [
    snapshot({ buyCountWindow: 0, sellCountWindow: 0, takenAt: NOW - 7800 }),
    snapshot({ buyCountWindow: 4, sellCountWindow: 2, takenAt: NOW - 3600 }),
  ];
  const prev = snapshot({ buyCountWindow: 8, sellCountWindow: 4, takenAt: NOW - 600 }); // +6 since previous point
  const signals = detectSignals({
    metrics: metrics({ buyCountWindow: 16, sellCountWindow: 8 }), // +12 trades over 10 min = 1.2/min = 12x the 0.10/min baseline
    risk: CLEAN_RISK,
    previousSnapshot: prev,
    launchTimestamp: NOW - 14400, // 4 hours old — comfortably past the 1h eligibility bar
    snapshotHistory: [...history, prev],
    now: NOW,
  });
  const accel = signals.find((s) => s.type === "ACTIVITY_ACCELERATION");
  assert.ok(accel);
  assert.equal(accel!.severity, "HIGH"); // multiplier >= 8x
  assert.match(accel!.evidence, /lifetime average of 0\.10\/min/);
  assert.match(accel!.evidence, /12\.0x/);
});

test("a mature token trading near its own normal pace does NOT fire acceleration, even though the current rate alone would have cleared the old fixed threshold", () => {
  // Lifetime baseline is a genuinely busy ~6.4/min token; current rate (2.5/min) is
  // actually below that baseline — old fixed rule (>=2/min = MEDIUM) would have
  // fired regardless of context; the baseline-aware version correctly doesn't.
  const history = [
    snapshot({ buyCountWindow: 0, sellCountWindow: 0, takenAt: NOW - 10800 }),
    snapshot({ buyCountWindow: 180, sellCountWindow: 180, takenAt: NOW - 7200 }),
    snapshot({ buyCountWindow: 360, sellCountWindow: 360, takenAt: NOW - 3600 }),
  ];
  const prev = snapshot({ buyCountWindow: 540, sellCountWindow: 540, takenAt: NOW - 600 });
  const signals = detectSignals({
    metrics: metrics({ buyCountWindow: 552, sellCountWindow: 553 }), // +25 trades over 10min = 2.5/min
    risk: CLEAN_RISK,
    previousSnapshot: prev,
    launchTimestamp: NOW - 14400,
    snapshotHistory: [...history, prev],
    now: NOW,
  });
  assert.equal(signals.some((s) => s.type === "ACTIVITY_ACCELERATION"), false);
});

test("no launchTimestamp at all (enrichment failed) falls back to the fixed threshold, never crashes or silently drops the signal", () => {
  const prev = snapshot({ buyCountWindow: 10, sellCountWindow: 5, takenAt: NOW - 600 });
  const signals = detectSignals({
    metrics: metrics({ buyCountWindow: 40, sellCountWindow: 10 }),
    risk: CLEAN_RISK,
    previousSnapshot: prev,
    launchTimestamp: null,
    snapshotHistory: [prev, snapshot({ buyCountWindow: 2, takenAt: NOW - 7200 }), snapshot({ buyCountWindow: 5, takenAt: NOW - 3600 })],
    now: NOW,
  });
  const accel = signals.find((s) => s.type === "ACTIVITY_ACCELERATION");
  assert.ok(accel);
  assert.doesNotMatch(accel!.evidence, /lifetime average/);
});

test("a near-zero lifetime baseline (rounds to ~0/min) is treated as no usable baseline, not an absurd multiplier", () => {
  // 1 trade total over 4 hours ≈ 0.004/min — below MIN_BASELINE_RATE_PER_MINUTE
  const history = [
    snapshot({ buyCountWindow: 0, sellCountWindow: 0, takenAt: NOW - 14400 }),
    snapshot({ buyCountWindow: 1, sellCountWindow: 0, takenAt: NOW - 7200 }),
  ];
  const prev = snapshot({ buyCountWindow: 1, sellCountWindow: 0, takenAt: NOW - 600 });
  const signals = detectSignals({
    metrics: metrics({ buyCountWindow: 4, sellCountWindow: 4 }), // +7 trades over 10min
    risk: CLEAN_RISK,
    previousSnapshot: prev,
    launchTimestamp: NOW - 14400,
    snapshotHistory: [...history, prev],
    now: NOW,
  });
  const accel = signals.find((s) => s.type === "ACTIVITY_ACCELERATION");
  assert.ok(accel);
  // Falls back to the fixed-threshold format rather than reporting a wild multiplier off a near-zero baseline
  assert.doesNotMatch(accel!.evidence, /lifetime average/);
});

test("every signal timestamp equals the injected `now`, never a live clock read inside detection", () => {
  const signals = detectSignals({ metrics: metrics({ buyCountWindow: 10, sellCountWindow: 1 }), risk: CLEAN_RISK, previousSnapshot: null, now: NOW });
  assert.ok(signals.every((s) => s.timestamp === NOW));
});

test("a token graduating between two snapshots emits PHASE_CHANGE as its own real event", () => {
  const prev = snapshot({ graduated: false, takenAt: NOW - 600 });
  const signals = detectSignals({ metrics: metrics({ graduated: true }), risk: CLEAN_RISK, previousSnapshot: prev, now: NOW });
  const phaseChange = signals.find((s) => s.type === "PHASE_CHANGE");
  assert.ok(phaseChange);
  assert.match(phaseChange!.evidence, /graduated/);
});

test("a legitimate liquidity change caused by graduation is never reported as LIQUIDITY_DECREASE — the phase guard suppresses it", () => {
  const prev = snapshot({ graduated: false, liquidityUsd: 40_000, takenAt: NOW - 600 });
  // Even if a future provider did return a real (lower) post-graduation liquidity number,
  // the phase-change guard must suppress the comparison rather than call it a collapse.
  const signals = detectSignals({
    metrics: metrics({ graduated: true, liquidityUsd: 5_000 }),
    risk: CLEAN_RISK,
    previousSnapshot: prev,
    now: NOW,
  });
  assert.equal(signals.some((s) => s.type === "LIQUIDITY_DECREASE" || s.type === "LIQUIDITY_INCREASE"), false);
});

test("liquidity signals fire normally when the phase hasn't changed — the guard doesn't suppress real trend detection", () => {
  const prev = snapshot({ graduated: false, liquidityUsd: 40_000, takenAt: NOW - 600 });
  const signals = detectSignals({ metrics: metrics({ graduated: false, liquidityUsd: 5_000 }), risk: CLEAN_RISK, previousSnapshot: prev, now: NOW });
  assert.ok(signals.some((s) => s.type === "LIQUIDITY_DECREASE"));
});

test("no PHASE_CHANGE when the phase is unknown on either side — never guessed from incomplete data", () => {
  const prev = snapshot({ graduated: null, takenAt: NOW - 600 });
  const signals = detectSignals({ metrics: metrics({ graduated: true }), risk: CLEAN_RISK, previousSnapshot: prev, now: NOW });
  assert.equal(signals.some((s) => s.type === "PHASE_CHANGE"), false);
});
