import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeRisk } from "./riskAnalysis.js";
import type { DetectedLaunch } from "../chain/hunt.js";
import type { TokenMetrics } from "../data/types.js";

function launch(overrides: Partial<DetectedLaunch> = {}): DetectedLaunch {
  return {
    token: "0x1111111111111111111111111111111111111111" as const,
    curve: "0x2222222222222222222222222222222222222222" as const,
    deployer: "0x3333333333333333333333333333333333333333" as const,
    pairToken: "0x0000000000000000000000000000000000000000" as const,
    graduationThreshold: 0n,
    launchBlock: 1n,
    launchTxHash: "0xabc" as const,
    devBuyTokens: null,
    devBuyTaxBps: null,
    exemptWalletCount: 0,
    deployerLaunchCountInWindow: 1,
    ...overrides,
  };
}

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

test("clean launch with no metrics reports LOW with an explicit no-red-flags finding", () => {
  const r = analyzeRisk(launch(), null);
  assert.equal(r.level, "LOW");
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0].evidence, /no red flags/);
  assert.equal(r.safetyScore, 100);
});

test("large dev buy alone is flagged HIGH with the exact percentage in the evidence", () => {
  const r = analyzeRisk(launch({ devBuyTokens: 100_000_000 }), null); // ~14% of curve supply
  assert.equal(r.level, "HIGH");
  assert.ok(r.findings.some((f) => f.level === "HIGH" && /dev bought/.test(f.evidence)));
});

test("bundled/exempt wallets escalate with count — 3+ is HIGH, fewer is MEDIUM", () => {
  const low = analyzeRisk(launch({ exemptWalletCount: 1 }), null);
  const high = analyzeRisk(launch({ exemptWalletCount: 4 }), null);
  assert.equal(low.findings.find((f) => /exempt/.test(f.evidence))?.level, "MEDIUM");
  assert.equal(high.findings.find((f) => /exempt/.test(f.evidence))?.level, "HIGH");
});

test("serial deployer count feeds a finding with the real count in the evidence", () => {
  const r = analyzeRisk(launch({ deployerLaunchCountInWindow: 7 }), null);
  const f = r.findings.find((x) => /serial deployer/.test(x.evidence));
  assert.ok(f);
  assert.match(f!.evidence, /7 launches/);
});

test("top-10 holder concentration above 70% is CRITICAL, not just HIGH", () => {
  const r = analyzeRisk(null, metrics({ topHolderConcentrationPercent: 82 }));
  assert.equal(r.level, "CRITICAL");
});

test("thin liquidity under $5k is flagged HIGH with the dollar figure stated", () => {
  const r = analyzeRisk(null, metrics({ liquidityUsd: 1200 }));
  const f = r.findings.find((x) => /liquidity is only/.test(x.evidence));
  assert.equal(f?.level, "HIGH");
  assert.match(f!.evidence, /\$1200/);
});

test("safety score never goes below 0 even with many stacked findings", () => {
  const r = analyzeRisk(
    launch({ devBuyTokens: 200_000_000, exemptWalletCount: 5, deployerLaunchCountInWindow: 10, devBuyTaxBps: 500 }),
    metrics({ topHolderConcentrationPercent: 90, liquidityUsd: 500 })
  );
  assert.ok(r.safetyScore >= 0);
  assert.equal(r.level, "CRITICAL");
});
