import { test } from "node:test";
import assert from "node:assert/strict";
import { explainWhyItsMoving } from "./explain.js";
import { computeFletchScore } from "../scoring/fletchScore.js";
import type { TokenMetrics } from "../data/types.js";
import type { RiskReport } from "../risk/riskAnalysis.js";

const NO_SMART_MONEY = { available: false as const, reason: "no wallet history store yet" };
const NO_SOCIAL = { available: false as const, reason: "no social source wired up" };

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
    ...overrides,
  };
}

const CLEAN_RISK: RiskReport = { level: "LOW", findings: [{ level: "LOW", evidence: "no red flags found" }], safetyScore: 100 };

test("every bullet traces to a real number that was passed in — no bullet appears out of nowhere", () => {
  const m = metrics({ buyCountWindow: 12, sellCountWindow: 3, holderCount: 88, liquidityUsd: 24_000 });
  const score = computeFletchScore(m, CLEAN_RISK, NO_SMART_MONEY, NO_SOCIAL);
  const why = explainWhyItsMoving(m, CLEAN_RISK, score);

  assert.ok(why.bullets.some((b) => b.includes("12 buys")));
  assert.ok(why.bullets.some((b) => b.includes("88 holders")));
  assert.ok(why.bullets.some((b) => b.includes("$24,000")));
});

test("unavailable smart-money and social show up as explicit unavailable bullets, not silence or fake numbers", () => {
  const m = metrics({ buyCountWindow: 1, sellCountWindow: 0 });
  const score = computeFletchScore(m, CLEAN_RISK, NO_SMART_MONEY, NO_SOCIAL);
  const why = explainWhyItsMoving(m, CLEAN_RISK, score);

  assert.ok(why.bullets.some((b) => b.startsWith("smart-money activity: unavailable")));
  assert.ok(why.bullets.some((b) => b.startsWith("social momentum: unavailable")));
});

test("risk bullets only surface findings above LOW, prefixed with the exact level", () => {
  const risk: RiskReport = {
    level: "HIGH",
    findings: [
      { level: "LOW", evidence: "small dev buy" },
      { level: "HIGH", evidence: "top 10 holders own 61%" },
    ],
    safetyScore: 40,
  };
  const m = metrics();
  const score = computeFletchScore(m, risk, NO_SMART_MONEY, NO_SOCIAL);
  const why = explainWhyItsMoving(m, risk, score);

  assert.deepEqual(why.risks, ["[HIGH] top 10 holders own 61%"]);
});

test("a genuinely clean token still gets one explicit LOW risk line, never an empty risk list", () => {
  const m = metrics();
  const score = computeFletchScore(m, CLEAN_RISK, NO_SMART_MONEY, NO_SOCIAL);
  const why = explainWhyItsMoving(m, CLEAN_RISK, score);
  assert.equal(why.risks.length, 1);
  assert.match(why.risks[0], /^\[LOW\]/);
});
