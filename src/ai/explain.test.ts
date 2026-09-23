import { test } from "node:test";
import assert from "node:assert/strict";
import { explainWhyItsMoving } from "./explain.js";
import type { Signal } from "../signals/types.js";
import type { RiskReport } from "../risk/riskAnalysis.js";

const NOW = 1_700_000_000;

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    type: "BUY_PRESSURE",
    severity: "MEDIUM",
    confidence: 70,
    evidence: "12 buys vs 3 sells",
    explanation: "Buy activity is outweighing sell activity.",
    timestamp: NOW,
    ...overrides,
  };
}

const CLEAN_RISK: RiskReport = { level: "LOW", findings: [{ level: "LOW", code: "CLEAN", evidence: "no red flags found" }], safetyScore: 100 };

test("every bullet is a direct render of a signal's own explanation + evidence — nothing added", () => {
  const s = signal({ explanation: "Holder count increased since the last check.", evidence: "100 → 142 (+42.0%) over 10m" });
  const why = explainWhyItsMoving([s], CLEAN_RISK);
  assert.equal(why.bullets.length, 1);
  assert.equal(why.bullets[0], "Holder count increased since the last check. (100 → 142 (+42.0%) over 10m)");
});

test("with zero signals, shows an explicit unavailable bullet in the brief's own phrasing — never silence", () => {
  const why = explainWhyItsMoving([], CLEAN_RISK);
  assert.equal(why.bullets.length, 1);
  assert.equal(why.bullets[0], "Unavailable — not enough signal data yet to explain recent movement.");
  assert.equal(why.insufficientData, true);
});

test("risk-derived signal types (deployer risk, concentration, etc.) are excluded from movement bullets — shown once, in Risk", () => {
  const signals = [
    signal({ type: "BUY_PRESSURE", explanation: "Buy pressure." }),
    signal({ type: "HOLDER_CONCENTRATION", severity: "HIGH", explanation: "top 10 holders own 61%", evidence: "top 10 holders own 61%" }),
  ];
  const why = explainWhyItsMoving(signals, CLEAN_RISK);
  assert.equal(why.bullets.length, 1);
  assert.ok(why.bullets[0].includes("Buy pressure"));
});

test("movement bullets are ordered by severity, most notable first", () => {
  const signals = [
    signal({ type: "PRICE_UP", severity: "LOW", explanation: "low", evidence: "e1" }),
    signal({ type: "WHALE_BUY_FROM_CURVE", severity: "HIGH", explanation: "high", evidence: "e2" }),
    signal({ type: "HOLDER_GROWTH", severity: "MEDIUM", explanation: "medium", evidence: "e3" }),
  ];
  const why = explainWhyItsMoving(signals, CLEAN_RISK);
  assert.deepEqual(why.bullets, ["high (e2)", "medium (e3)", "low (e1)"]);
});

test("risk bullets only surface findings above LOW, prefixed with the exact level", () => {
  const risk: RiskReport = {
    level: "HIGH",
    findings: [
      { level: "LOW", code: "CLEAN", evidence: "small dev buy" },
      { level: "HIGH", code: "HOLDER_CONCENTRATION", evidence: "top 10 holders own 61%" },
    ],
    safetyScore: 40,
  };
  const why = explainWhyItsMoving([], risk);
  assert.deepEqual(why.risks, ["[HIGH] top 10 holders own 61%"]);
});

test("a genuinely clean token still gets one explicit LOW risk line, never an empty risk list", () => {
  const why = explainWhyItsMoving([], CLEAN_RISK);
  assert.equal(why.risks.length, 1);
  assert.match(why.risks[0], /^\[LOW\]/);
});

test("insufficientData is true only when there are zero movement signals, regardless of risk findings", () => {
  const riskOnly = explainWhyItsMoving([signal({ type: "THIN_LIQUIDITY" })], CLEAN_RISK);
  assert.equal(riskOnly.insufficientData, true); // THIN_LIQUIDITY is risk-derived, not a movement signal

  const withMovement = explainWhyItsMoving([signal({ type: "BUY_PRESSURE" })], CLEAN_RISK);
  assert.equal(withMovement.insufficientData, false);
});

test("REGRESSION (WALS): dozens of whale moves roll up into one line per kind, with count, total and the largest tx", () => {
  const whales = Array.from({ length: 13 }, (_, i) =>
    signal({ type: "WHALE_BUY_FROM_CURVE", severity: "MEDIUM", explanation: "A large buy came directly off the bonding curve.", evidence: `${(i + 1) * 1_000_000 === 13_000_000 ? "64,796,259" : ((i + 1) * 1_000_000).toLocaleString("en-US")} tokens bought from the curve in tx 0x${i}` })
  );
  const why = explainWhyItsMoving(whales, CLEAN_RISK);
  assert.equal(why.bullets.length, 1);
  assert.match(why.bullets[0], /^13 large buy\(s\) came directly off the bonding curve/);
  assert.match(why.bullets[0], /largest: 64,796,259 tokens bought from the curve in tx 0x12/);
});

test("never more than 8 bullets, however noisy the token", () => {
  const many = Array.from({ length: 20 }, (_, i) => signal({ type: "PRICE_UP", severity: "LOW", explanation: `x${i}`, evidence: "e" }));
  assert.equal(explainWhyItsMoving(many, CLEAN_RISK).bullets.length, 8);
});
