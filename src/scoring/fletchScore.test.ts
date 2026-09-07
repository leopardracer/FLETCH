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
    whaleMoves: [],
    ...overrides,
  };
}

const CLEAN_RISK: RiskReport = { level: "LOW", findings: [{ level: "LOW", code: "CLEAN", evidence: "no red flags found" }], safetyScore: 100 };

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
  const risk: RiskReport = { level: "HIGH", findings: [{ level: "HIGH", code: "DEV_BUY", evidence: "x" }], safetyScore: 64 };
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

test("whale activity is unavailable when the holder scan itself failed, not when it succeeded with zero whales", () => {
  const scanFailed = computeFletchScore(metrics({ holderCount: null }), CLEAN_RISK, NO_SMART_MONEY, NO_SOCIAL);
  assert.equal(scanFailed.components.whaleActivity.value, null);

  const scanSucceededNoWhales = computeFletchScore(metrics({ holderCount: 50, whaleMoves: [] }), CLEAN_RISK, NO_SMART_MONEY, NO_SOCIAL);
  assert.equal(scanSucceededNoWhales.components.whaleActivity.value, 50);
});

test("whale activity score leans toward buys when curve-buy volume dominates curve-sell volume", () => {
  const CURVE = "0x2222222222222222222222222222222222222222" as const;
  const buyHeavy = computeFletchScore(
    metrics({
      holderCount: 50,
      whaleMoves: [{ from: CURVE, to: "0x1111111111111111111111111111111111111111" as const, amount: 10_000, txHash: "0xa" as const, blockNumber: 1n }],
    }),
    CLEAN_RISK,
    NO_SMART_MONEY,
    NO_SOCIAL,
    null,
    CURVE
  );
  const sellHeavy = computeFletchScore(
    metrics({
      holderCount: 50,
      whaleMoves: [{ from: "0x1111111111111111111111111111111111111111" as const, to: CURVE, amount: 10_000, txHash: "0xb" as const, blockNumber: 1n }],
    }),
    CLEAN_RISK,
    NO_SMART_MONEY,
    NO_SOCIAL,
    null,
    CURVE
  );
  assert.ok(buyHeavy.components.whaleActivity.value! > sellHeavy.components.whaleActivity.value!);
});

test("holder growth uses a real percentage once a previous snapshot exists, and falls back honestly without one", () => {
  const noHistory = computeFletchScore(metrics({ holderCount: 300 }), CLEAN_RISK, NO_SMART_MONEY, NO_SOCIAL);
  assert.match(noHistory.components.holderGrowth.label, /no history yet/);

  const prev = { holderCount: 100 } as any;
  const withHistory = computeFletchScore(metrics({ holderCount: 150 }), CLEAN_RISK, NO_SMART_MONEY, NO_SOCIAL, prev);
  assert.match(withHistory.components.holderGrowth.label, /100 → 150 holders \(\+50\.0%\)/);
  assert.equal(withHistory.components.holderGrowth.value, 100); // clamped: 50 + 50% = 100
});
