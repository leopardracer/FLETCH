import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLifecycles } from "./lifecycle.js";
import type { Signal } from "./types.js";

const NOW = 1_700_000_000;
const W = 1800;
function s(type: Signal["type"], agoSeconds: number, severity: Signal["severity"] = "MEDIUM"): Signal {
  return { type, severity, confidence: 70, evidence: "e", explanation: "x", timestamp: NOW - agoSeconds };
}
const stageOf = (signals: Signal[], type: Signal["type"]) => computeLifecycles(signals, NOW, W).find((l) => l.type === type)!.stage;

test("first appearance in the recent window → DETECTED", () => {
  assert.equal(stageOf([s("BUY_PRESSURE", 60)], "BUY_PRESSURE"), "DETECTED");
});

test("more occurrences than the window before → STRENGTHENING", () => {
  assert.equal(stageOf([s("BUY_PRESSURE", 60), s("BUY_PRESSURE", 600), s("BUY_PRESSURE", 2000)], "BUY_PRESSURE"), "STRENGTHENING");
});

test("same count but a higher severity now → STRENGTHENING", () => {
  assert.equal(stageOf([s("LIQUIDITY_DECREASE", 60, "CRITICAL"), s("LIQUIDITY_DECREASE", 2000, "MEDIUM")], "LIQUIDITY_DECREASE"), "STRENGTHENING");
});

test("same count, same severity → STEADY", () => {
  assert.equal(stageOf([s("HOLDER_GROWTH", 60), s("HOLDER_GROWTH", 2000)], "HOLDER_GROWTH"), "STEADY");
});

test("fewer than before → FADING", () => {
  assert.equal(stageOf([s("SELL_PRESSURE", 60), s("SELL_PRESSURE", 2000), s("SELL_PRESSURE", 2100)], "SELL_PRESSURE"), "FADING");
});

test("silent now but seen within 3 windows → FADING; silent for 3+ windows → RESOLVED", () => {
  assert.equal(stageOf([s("PRICE_UP", 2 * W)], "PRICE_UP"), "FADING");
  assert.equal(stageOf([s("PRICE_UP", 3 * W + 1)], "PRICE_UP"), "RESOLVED");
});

test("each signal type gets its own lifecycle, strengthening first", () => {
  const all = computeLifecycles([s("PRICE_UP", 4 * W), s("BUY_PRESSURE", 60), s("BUY_PRESSURE", 90), s("BUY_PRESSURE", 2000)], NOW, W);
  assert.deepEqual(all.map((l) => [l.type, l.stage]), [["BUY_PRESSURE", "STRENGTHENING"], ["PRICE_UP", "RESOLVED"]]);
  assert.equal(all[0].recentCount, 2);
  assert.equal(all[0].previousCount, 1);
});

test("no signals → no lifecycles, never a made-up stage", () => {
  assert.deepEqual(computeLifecycles([], NOW, W), []);
});
