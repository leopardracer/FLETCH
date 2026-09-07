import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFletchScore } from "./fletchScore.js";
import type { TokenMetrics } from "../data/types.js";
import type { RiskReport } from "../risk/riskAnalysis.js";
import type { SmartMoneyReport } from "../wallets/smartMoney.js";
import type { SocialReport } from "../social/social.js";

const NO_SMART_MONEY: SmartMoneyReport = { available: false, reason: "no wallet history store yet" };
const NO_SOCIAL: SocialReport = { available: false, reason: "no social source wired up" };

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

test("with smart money and social unavailable, overall score is null only if EVERY component is unavailable", () => {
  const score = computeFletchScore(metrics(), CLEAN_RISK, NO_SMART_MONEY, NO_SOCIAL);
  // safety is always available (comes from risk analysis, which always returns a value) -> overall must be a number
  assert.notEqual(score.overall, null);
  assert.equal(score.components.smartMoney.value, null);
  assert.equal(score.components.social.value, null);
});

test("unavailable components carry their stated reason through to the component score", () => {
  const score = computeFletchScore(metrics(), CLEAN_RISK, NO_SMART_MONEY, NO_SOCIAL);
  assert.equal(score.components.smartMoney.reason, NO_SMART_MONEY.reason);
  assert.equal(score.components.social.reason, NO_SOCIAL.reason);
});

test("safety is derived from risk analysis, which always returns a value — so overall is never null in practice", () => {
  const score = computeFletchScore(metrics(), CLEAN_RISK, NO_SMART_MONEY, NO_SOCIAL);
  assert.notEqual(score.overall, null);
  assert.ok("safety" in score.weightsUsed);
});

test("liquidity component scales with USD liquidity and is unavailable with a reason when liquidity is null", () => {
  const withLiquidity = computeFletchScore(metrics({ liquidityUsd: 50_000 }), CLEAN_RISK, NO_SMART_MONEY, NO_SOCIAL);
  assert.ok(withLiquidity.components.liquidity.value! > 0);

  const noLiquidity = computeFletchScore(
    metrics({ liquidityUsd: null, liquidityUsdUnavailableReason: "no pool found" }),
    CLEAN_RISK,
    NO_SMART_MONEY,
    NO_SOCIAL
  );
  assert.equal(noLiquidity.components.liquidity.value, null);
  assert.equal(noLiquidity.components.liquidity.reason, "no pool found");
});

test("momentum is unavailable with zero buy/sell activity rather than defaulting to a score", () => {
  const score = computeFletchScore(metrics({ buyCountWindow: 0, sellCountWindow: 0 }), CLEAN_RISK, NO_SMART_MONEY, NO_SOCIAL);
  assert.equal(score.components.momentum.value, null);
});

test("more buy pressure yields a higher momentum score than balanced activity, all else equal", () => {
  const buyHeavy = computeFletchScore(metrics({ buyCountWindow: 18, sellCountWindow: 2 }), CLEAN_RISK, NO_SMART_MONEY, NO_SOCIAL);
  const balanced = computeFletchScore(metrics({ buyCountWindow: 10, sellCountWindow: 10 }), CLEAN_RISK, NO_SMART_MONEY, NO_SOCIAL);
  assert.ok(buyHeavy.components.momentum.value! > balanced.components.momentum.value!);
});

test("safety component score matches the risk report's safetyScore exactly — no re-derivation", () => {
  const risk: RiskReport = { level: "HIGH", findings: [{ level: "HIGH", evidence: "x" }], safetyScore: 64 };
  const score = computeFletchScore(metrics(), risk, NO_SMART_MONEY, NO_SOCIAL);
  assert.equal(score.components.safety.value, 64);
});

test("weightsUsed only lists components that actually had a value, and they sum to ~1", () => {
  const score = computeFletchScore(metrics({ liquidityUsd: 10_000, holderCount: 50 }), CLEAN_RISK, NO_SMART_MONEY, NO_SOCIAL);
  assert.ok(!("smartMoney" in score.weightsUsed));
  assert.ok(!("social" in score.weightsUsed));
  const sum = Object.values(score.weightsUsed).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 0.02);
});
