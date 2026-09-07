import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useInMemoryDbForTests } from "../persistence/db.js";
import { getSnapshotHistory } from "../persistence/snapshots.js";
import { getSignalsForToken } from "../persistence/signalsStore.js";
import { analyzeAndPersist, COMPARISON_WINDOW_SECONDS } from "./signalService.js";
import type { TokenMetrics } from "../data/types.js";
import type { DetectedLaunch } from "../chain/hunt.js";

/**
 * Integration tests: chain metrics -> risk -> score -> signals ->
 * persistence, exercised together through the one function every real
 * code path (API, poller) actually calls. No network, no live RPC —
 * `metrics`/`launch` below are synthetic, standing in for what a
 * ChainDataProvider would have returned. Each in-memory DB is fresh per
 * test (see beforeEach), so persisted side effects are exactly what this
 * test itself wrote.
 */

const TOKEN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const CURVE = "0xccccccccccccccccccccccccccccccccccccccc0" as const;
const NOW = 1_700_000_000;

beforeEach(() => {
  useInMemoryDbForTests();
});

function metrics(overrides: Partial<TokenMetrics> = {}): TokenMetrics {
  return {
    priceInPair: 1,
    liquidityPairAsset: 25,
    liquidityUsd: 50_000, // above the $20k THIN_LIQUIDITY threshold — a genuinely clean baseline
    holderCount: 100,
    holderCountIsLifetime: true,
    buyCountWindow: 10,
    sellCountWindow: 2,
    volumePairAssetWindow: 3,
    topHolderConcentrationPercent: 20,
    whaleMoves: [],
    graduated: null,
    ...overrides,
  };
}

function launch(overrides: Partial<DetectedLaunch> = {}): DetectedLaunch {
  return {
    token: TOKEN,
    curve: CURVE,
    deployer: "0xdddddddddddddddddddddddddddddddddddddd" as const,
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

const NO_SMART_MONEY = { available: false as const, reason: "no wallet history store yet" };
const NO_SOCIAL = { available: false as const, reason: "no social source wired up" };

test("a first-ever read produces risk + score + signals and persists exactly one snapshot", () => {
  const result = analyzeAndPersist(TOKEN, launch(), metrics(), NO_SMART_MONEY, NO_SOCIAL, NOW);

  assert.ok(result.score.overall !== null);
  assert.equal(result.risk.level, "LOW");

  const history = getSnapshotHistory(TOKEN);
  assert.equal(history.length, 1);
  assert.equal(history[0].fletchScore, result.score.overall);
});

test("with no history yet, only point-in-time signals fire — no trend signal claims a comparison that didn't happen", () => {
  const result = analyzeAndPersist(TOKEN, launch(), metrics({ buyCountWindow: 20, sellCountWindow: 1 }), NO_SMART_MONEY, NO_SOCIAL, NOW);
  assert.equal(result.signals.some((s) => s.type === "HOLDER_GROWTH" || s.type === "LIQUIDITY_INCREASE"), false);
  assert.ok(result.signals.some((s) => s.type === "BUY_PRESSURE"));
});

test("a second read outside the comparison window produces real trend signals, sourced from the first read's persisted snapshot", () => {
  analyzeAndPersist(TOKEN, launch(), metrics({ holderCount: 100 }), NO_SMART_MONEY, NO_SOCIAL, NOW);
  const later = NOW + COMPARISON_WINDOW_SECONDS + 60;
  const result = analyzeAndPersist(TOKEN, launch(), metrics({ holderCount: 180 }), NO_SMART_MONEY, NO_SOCIAL, later);

  const growth = result.signals.find((s) => s.type === "HOLDER_GROWTH");
  assert.ok(growth, "expected a HOLDER_GROWTH signal once real snapshot history exists");
  assert.match(growth!.evidence, /100 → 180/);

  assert.equal(getSnapshotHistory(TOKEN).length, 2);
});

test("every detected signal is actually persisted and retrievable via the token's own signal timeline", () => {
  const result = analyzeAndPersist(TOKEN, launch({ exemptWalletCount: 3 }), metrics(), NO_SMART_MONEY, NO_SOCIAL, NOW);
  const stored = getSignalsForToken(TOKEN);
  assert.equal(stored.length, result.signals.length);
  assert.ok(stored.some((s) => s.type === "BUNDLED_WALLETS"));
});

test("risk findings feed both the score's Safety component and the signal feed from the same computation — no drift between them", () => {
  const result = analyzeAndPersist(TOKEN, launch({ exemptWalletCount: 4 }), metrics(), NO_SMART_MONEY, NO_SOCIAL, NOW);
  const bundledSignal = result.signals.find((s) => s.type === "BUNDLED_WALLETS");
  const bundledFinding = result.risk.findings.find((f) => f.code === "BUNDLED_WALLETS");
  assert.ok(bundledSignal && bundledFinding);
  assert.equal(bundledSignal!.evidence, bundledFinding!.evidence);
  assert.ok(result.score.components.safety.value! < 100);
});

test("a token with a failed/empty metrics read (holderCount null) still produces a result — unavailable components, not a crash", () => {
  const result = analyzeAndPersist(
    TOKEN,
    null,
    metrics({ holderCount: null, liquidityUsd: null, buyCountWindow: 0, sellCountWindow: 0, topHolderConcentrationPercent: null }),
    NO_SMART_MONEY,
    NO_SOCIAL,
    NOW
  );
  assert.equal(result.score.components.holderGrowth.value, null);
  assert.equal(result.score.components.whaleActivity.value, null);
  assert.equal(result.score.components.liquidity.value, null);
  // Safety always resolves from risk analysis, so overall is still a number.
  assert.notEqual(result.score.overall, null);
});

test("repeated reads within the rate-limit window don't inflate snapshot history, even though signals/risk are recomputed each time", () => {
  analyzeAndPersist(TOKEN, launch(), metrics(), NO_SMART_MONEY, NO_SOCIAL, NOW);
  analyzeAndPersist(TOKEN, launch(), metrics(), NO_SMART_MONEY, NO_SOCIAL, NOW + 5); // well inside the 60s default rate limit
  assert.equal(getSnapshotHistory(TOKEN).length, 1);
});

test("signal history is deduplicated the same way snapshots are — a rapid repeat read doesn't re-file identical signal rows", () => {
  analyzeAndPersist(TOKEN, launch(), metrics({ buyCountWindow: 20, sellCountWindow: 1 }), NO_SMART_MONEY, NO_SOCIAL, NOW);
  const firstCount = getSignalsForToken(TOKEN).length;
  assert.ok(firstCount > 0, "expected at least one signal (BUY_PRESSURE) from the first read");

  // Three more reads, all inside the 60s rate-limit window, all producing the same signals in memory.
  analyzeAndPersist(TOKEN, launch(), metrics({ buyCountWindow: 20, sellCountWindow: 1 }), NO_SMART_MONEY, NO_SOCIAL, NOW + 5);
  analyzeAndPersist(TOKEN, launch(), metrics({ buyCountWindow: 20, sellCountWindow: 1 }), NO_SMART_MONEY, NO_SOCIAL, NOW + 10);
  analyzeAndPersist(TOKEN, launch(), metrics({ buyCountWindow: 20, sellCountWindow: 1 }), NO_SMART_MONEY, NO_SOCIAL, NOW + 15);

  assert.equal(getSignalsForToken(TOKEN).length, firstCount, "no new signal rows should have been written inside the rate-limit window");
});

test("a read outside the rate-limit window DOES persist new signals, even if they're the same type as before", () => {
  analyzeAndPersist(TOKEN, launch(), metrics({ buyCountWindow: 20, sellCountWindow: 1 }), NO_SMART_MONEY, NO_SOCIAL, NOW);
  const firstCount = getSignalsForToken(TOKEN).length;

  const later = NOW + 120; // outside the default 60s rate limit
  analyzeAndPersist(TOKEN, launch(), metrics({ buyCountWindow: 20, sellCountWindow: 1 }), NO_SMART_MONEY, NO_SOCIAL, later);

  assert.ok(getSignalsForToken(TOKEN).length > firstCount, "a genuinely new snapshot should persist its signals, even if they repeat the previous type");
});

test("the in-memory result still reflects the current read's real signals even when persistence is skipped as a duplicate", () => {
  analyzeAndPersist(TOKEN, launch(), metrics({ buyCountWindow: 20, sellCountWindow: 1 }), NO_SMART_MONEY, NO_SOCIAL, NOW);
  const result = analyzeAndPersist(TOKEN, launch(), metrics({ buyCountWindow: 20, sellCountWindow: 1 }), NO_SMART_MONEY, NO_SOCIAL, NOW + 5);
  // Persistence was skipped (dedup), but the caller (e.g. the API response) still gets the real, freshly computed signals.
  assert.ok(result.signals.some((s) => s.type === "BUY_PRESSURE"));
});
