import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateRadarScore, explainRadar, RADAR_WINDOW_SECONDS_DEFAULT } from "./radarEngine.js";
import type { Signal } from "../signals/types.js";

const NOW = 1_700_000_000;

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

test("a token with zero signals is not a radar candidate — null, not a score of 0", () => {
  assert.equal(calculateRadarScore([], NOW), null);
});

test("a single fresh, full-confidence, CRITICAL signal scores exactly its severity magnitude — no convergence bonus with only one type", () => {
  const result = calculateRadarScore([signal({ severity: "CRITICAL", confidence: 100, timestamp: NOW })], NOW);
  assert.ok(result);
  assert.equal(result!.radarScore, 85); // SEVERITY_MAGNITUDE.CRITICAL, recency=1, confidence=1, multiplier=1
  assert.equal(result!.distinctSignalTypes, 1);
  assert.equal(result!.convergenceMultiplier, 1);
});

test("an identical signal type repeated many times scores the same as it firing once — volume alone never inflates the score", () => {
  const once = calculateRadarScore([signal({ timestamp: NOW })], NOW);
  const repeated = calculateRadarScore(
    [signal({ timestamp: NOW }), signal({ timestamp: NOW - 60 }), signal({ timestamp: NOW - 120 }), signal({ timestamp: NOW - 180 })],
    NOW
  );
  assert.equal(once!.radarScore, repeated!.radarScore);
  assert.equal(repeated!.distinctSignalTypes, 1);
});

test("two distinct signal types firing at once score higher than the stronger one alone — real convergence bonus", () => {
  const alone = calculateRadarScore([signal({ type: "WHALE_BUY_FROM_CURVE", severity: "HIGH", timestamp: NOW })], NOW);
  const converged = calculateRadarScore(
    [signal({ type: "WHALE_BUY_FROM_CURVE", severity: "HIGH", timestamp: NOW }), signal({ type: "HOLDER_GROWTH", severity: "LOW", timestamp: NOW })],
    NOW
  );
  assert.ok(converged!.radarScore > alone!.radarScore);
  assert.equal(converged!.convergenceMultiplier, 1.15);
});

test("a signal at the edge of the window contributes almost nothing; the same signal just-fired contributes fully", () => {
  const stale = calculateRadarScore([signal({ timestamp: NOW - RADAR_WINDOW_SECONDS_DEFAULT + 1 })], NOW);
  const fresh = calculateRadarScore([signal({ timestamp: NOW })], NOW);
  assert.ok(stale!.radarScore < fresh!.radarScore);
  assert.ok(stale!.radarScore <= 1); // recency ~0
});

test("a signal older than the window is excluded entirely, not just decayed to near-zero", () => {
  const result = calculateRadarScore([signal({ timestamp: NOW - RADAR_WINDOW_SECONDS_DEFAULT - 1 })], NOW);
  assert.equal(result, null);
});

test("radar score is clamped to 100 even with maximal convergence and severity", () => {
  const signals: Signal[] = [
    signal({ type: "WHALE_BUY_FROM_CURVE", severity: "CRITICAL", confidence: 100, timestamp: NOW }),
    signal({ type: "HOLDER_GROWTH", severity: "CRITICAL", confidence: 100, timestamp: NOW }),
    signal({ type: "BUY_PRESSURE", severity: "CRITICAL", confidence: 100, timestamp: NOW }),
    signal({ type: "ACTIVITY_ACCELERATION", severity: "CRITICAL", confidence: 100, timestamp: NOW }),
  ];
  const result = calculateRadarScore(signals, NOW);
  assert.equal(result!.radarScore, 100);
});

test("lower confidence reduces a signal's contribution proportionally", () => {
  const fullConfidence = calculateRadarScore([signal({ confidence: 100, timestamp: NOW })], NOW);
  const halfConfidence = calculateRadarScore([signal({ confidence: 50, timestamp: NOW })], NOW);
  assert.equal(halfConfidence!.radarScore, Math.round(fullConfidence!.radarScore / 2));
});

test("topSignal is the most severe signal in the window, regardless of which type drove the largest score contribution", () => {
  const result = calculateRadarScore(
    [signal({ type: "BUY_PRESSURE", severity: "LOW", timestamp: NOW }), signal({ type: "HOLDER_CONCENTRATION", severity: "CRITICAL", timestamp: NOW })],
    NOW
  );
  assert.equal(result!.topSignal.type, "HOLDER_CONCENTRATION");
});

test("lastSignalAt is the most recent signal's timestamp, not the window boundary", () => {
  const result = calculateRadarScore([signal({ timestamp: NOW - 500 }), signal({ type: "HOLDER_GROWTH", timestamp: NOW - 50 })], NOW);
  assert.equal(result!.lastSignalAt, NOW - 50);
});

test("explainRadar returns exactly one real sentence per distinct contributing signal type — never a fabricated merged narrative", () => {
  const result = calculateRadarScore(
    [
      signal({ type: "BUY_PRESSURE", explanation: "Buy activity is outweighing sell activity.", timestamp: NOW }),
      signal({ type: "HOLDER_GROWTH", explanation: "Holder count increased since the last check.", timestamp: NOW }),
    ],
    NOW
  );
  const why = explainRadar(result!);
  assert.equal(why.length, 2);
  assert.ok(why.includes("Buy activity is outweighing sell activity."));
  assert.ok(why.includes("Holder count increased since the last check."));
});

test("explainRadar with a single signal returns exactly that one sentence — 'if only one signal exists, say only that'", () => {
  const result = calculateRadarScore([signal({ explanation: "Buy activity is outweighing sell activity." })], NOW);
  assert.deepEqual(explainRadar(result!), ["Buy activity is outweighing sell activity."]);
});

test("calculation is fully deterministic — same inputs, same now, same result on repeated calls", () => {
  const signals = [signal({ timestamp: NOW - 30 }), signal({ type: "HOLDER_GROWTH", timestamp: NOW - 10 })];
  const a = calculateRadarScore(signals, NOW);
  const b = calculateRadarScore(signals, NOW);
  assert.deepEqual(a, b);
});
