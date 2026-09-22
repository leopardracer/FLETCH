import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useInMemoryDbForTests } from "../persistence/db.js";
import { recordWalletActivity } from "../persistence/walletActivityStore.js";
import { recordCurveScan } from "../persistence/walletTradesStore.js";
import { recordSnapshot } from "../persistence/snapshots.js";
import { getWalletIntelligence } from "./walletScore.js";
import type { TokenMetrics } from "../data/types.js";
import type { FletchScore } from "../scoring/fletchScore.js";

const WALLET = "0xcccccccccccccccccccccccccccccccccccccccc" as const;
const TOKEN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const TOKEN_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const NOW = 1_700_000_000;

beforeEach(() => {
  useInMemoryDbForTests();
});

const STILL_NOT_IMPLEMENTED = ["averageHoldingPeriod"] as const;

test("metrics that still lack real data stay NOT_YET_IMPLEMENTED with a stated reason — never a computed number", () => {
  const intel = getWalletIntelligence(WALLET);
  for (const key of STILL_NOT_IMPLEMENTED) {
    assert.equal(intel.metrics[key].availability, "NOT_YET_IMPLEMENTED");
    assert.equal(intel.metrics[key].value, undefined);
    assert.ok(intel.metrics[key].reason && intel.metrics[key].reason!.length > 0, `${key} must state why it isn't implemented`);
  }
});

test("with no recorded trades, realized PnL and win rate are UNAVAILABLE with a reason, not 0", () => {
  const intel = getWalletIntelligence(WALLET);
  assert.equal(intel.metrics.realizedPnl.availability, "UNAVAILABLE");
  assert.equal(intel.metrics.realizedPnl.value, undefined);
  assert.equal(intel.metrics.winRate.availability, "UNAVAILABLE");
  assert.ok(intel.metrics.winRate.reason);
});

test("a long snapshot-only history (no curve trades) still unlocks no PnL — more data isn't the same as the right data", () => {
  for (let i = 0; i < 20; i++) recordWalletActivity(WALLET, TOKEN, 100, 1, NOW + i * 100);
  const intel = getWalletIntelligence(WALLET);
  assert.equal(intel.metrics.realizedPnl.availability, "UNAVAILABLE");
  assert.equal(intel.metrics.winRate.availability, "UNAVAILABLE");
  assert.equal("walletScore" in intel, false);
  assert.equal("score" in intel, false);
});

test("real recorded trades from launch produce REAL realized PnL and win rate", () => {
  recordCurveScan(TOKEN, 100, 100, 300, [
    { wallet: WALLET, txHash: "0x01", logIndex: 0, blockNumber: 110, side: "buy", tokenAmount: 1000, quoteAmount: 1 },
    { wallet: WALLET, txHash: "0x02", logIndex: 0, blockNumber: 200, side: "sell", tokenAmount: 1000, quoteAmount: 1.5 },
  ]);
  recordCurveScan(TOKEN_B, 100, 100, 300, [
    { wallet: WALLET, txHash: "0x03", logIndex: 0, blockNumber: 110, side: "buy", tokenAmount: 1000, quoteAmount: 2 },
    { wallet: WALLET, txHash: "0x04", logIndex: 0, blockNumber: 200, side: "sell", tokenAmount: 1000, quoteAmount: 1.8 },
  ]);
  const intel = getWalletIntelligence(WALLET);
  assert.equal(intel.metrics.realizedPnl.availability, "REAL");
  assert.equal(intel.metrics.realizedPnl.unit, "ETH");
  assert.ok(Math.abs(intel.metrics.realizedPnl.value! - 0.3) < 1e-12);
  assert.equal(intel.metrics.winRate.availability, "REAL");
  assert.equal(intel.metrics.winRate.value, 50);
  assert.equal(intel.positions.length, 2);
});

test("an open position gives REAL realized PnL but win rate stays UNAVAILABLE — nothing is decided until it closes", () => {
  recordCurveScan(TOKEN, 100, 100, 300, [
    { wallet: WALLET, txHash: "0x01", logIndex: 0, blockNumber: 110, side: "buy", tokenAmount: 1000, quoteAmount: 1 },
  ]);
  const intel = getWalletIntelligence(WALLET);
  assert.equal(intel.metrics.realizedPnl.availability, "REAL");
  assert.equal(intel.metrics.realizedPnl.value, 0);
  assert.equal(intel.metrics.winRate.availability, "UNAVAILABLE");
});

test("trades on a token whose history FLETCH never saw from launch don't count", () => {
  recordCurveScan(TOKEN, 100, 5000, 9000, [
    { wallet: WALLET, txHash: "0x01", logIndex: 0, blockNumber: 6000, side: "buy", tokenAmount: 1000, quoteAmount: 1 },
    { wallet: WALLET, txHash: "0x02", logIndex: 0, blockNumber: 7000, side: "sell", tokenAmount: 1000, quoteAmount: 5 },
  ]);
  const intel = getWalletIntelligence(WALLET);
  assert.equal(intel.positions.length, 0);
  assert.equal(intel.metrics.realizedPnl.availability, "UNAVAILABLE");
});

test("profile is null and accumulationBehavior is UNAVAILABLE for a wallet with zero recorded activity", () => {
  const intel = getWalletIntelligence(WALLET);
  assert.equal(intel.profile, null);
  assert.equal(intel.metrics.accumulationBehavior.availability, "UNAVAILABLE");
  assert.ok(intel.metrics.accumulationBehavior.reason);
});

test("profile is real and accumulationBehavior is REAL once activity exists", () => {
  recordWalletActivity(WALLET, TOKEN, 100, 1, NOW);
  const intel = getWalletIntelligence(WALLET);
  assert.ok(intel.profile);
  assert.equal(intel.profile!.totalRecords, 1);
  assert.equal(intel.metrics.accumulationBehavior.availability, "REAL");
});

test("the wallet address on the response is normalized to lowercase, consistent with storage", () => {
  const mixedCase = "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" as const;
  const intel = getWalletIntelligence(mixedCase);
  assert.equal(intel.wallet, mixedCase.toLowerCase());
});

// ---------- unrealized PnL + early entry ----------

function snapshotMetrics(priceInPair: number | null, graduated: boolean | null): TokenMetrics {
  return {
    priceInPair, liquidityPairAsset: 5, liquidityUsd: 10_000, holderCount: 50, holderCountIsLifetime: true,
    buyCountWindow: 1, sellCountWindow: 0, volumePairAssetWindow: 1, topHolderConcentrationPercent: 20, whaleMoves: [], graduated,
  };
}
const SCORE: FletchScore = {
  overall: 50,
  components: {
    momentum: { value: 50, label: "" }, smartMoney: { value: null, label: "", reason: "unavailable" },
    social: { value: null, label: "", reason: "unavailable" }, liquidity: { value: 50, label: "" },
    holderGrowth: { value: 50, label: "" }, whaleActivity: { value: 50, label: "" }, safety: { value: 50, label: "" },
  },
  weightsUsed: {},
};

function openPositionOn(token: `0x${string}`, buyBlock = 110) {
  recordCurveScan(token, 100, 100, 300, [
    { wallet: WALLET, txHash: `0x${token.slice(-4)}01`, logIndex: 0, blockNumber: buyBlock, side: "buy", tokenAmount: 1000, quoteAmount: 1 },
  ]);
}

test("an open position on a live curve is valued at the latest curve price: held × price − cost", () => {
  openPositionOn(TOKEN);
  recordSnapshot(TOKEN, snapshotMetrics(0.003, false), SCORE, "LOW", NOW);
  const intel = getWalletIntelligence(WALLET, NOW + 60);
  assert.equal(intel.metrics.unrealizedPnl.availability, "REAL");
  assert.ok(Math.abs(intel.metrics.unrealizedPnl.value! - 2) < 1e-9); // 1000 × 0.003 − 1
  assert.equal(intel.metrics.unrealizedPnl.unit, "ETH");
});

test("a graduated token's open position is NOT valued with a stale curve price", () => {
  openPositionOn(TOKEN);
  recordSnapshot(TOKEN, snapshotMetrics(0.003, true), SCORE, "LOW", NOW);
  assert.equal(getWalletIntelligence(WALLET, NOW + 60).metrics.unrealizedPnl.availability, "UNAVAILABLE");
});

test("a curve price older than 24h isn't used", () => {
  openPositionOn(TOKEN);
  recordSnapshot(TOKEN, snapshotMetrics(0.003, false), SCORE, "LOW", NOW);
  assert.equal(getWalletIntelligence(WALLET, NOW + 25 * 3600).metrics.unrealizedPnl.availability, "UNAVAILABLE");
});

test("a gap between scans makes the holding itself uncertain — no unrealized PnL", () => {
  openPositionOn(TOKEN);
  recordCurveScan(TOKEN, 100, 500, 600, []); // blocks 301-499 never scanned
  recordSnapshot(TOKEN, snapshotMetrics(0.003, false), SCORE, "LOW", NOW);
  assert.equal(getWalletIntelligence(WALLET, NOW + 60).metrics.unrealizedPnl.availability, "UNAVAILABLE");
});

test("if ANY open position can't be valued, no partial total is shown", () => {
  openPositionOn(TOKEN);
  openPositionOn(TOKEN_B);
  recordSnapshot(TOKEN, snapshotMetrics(0.003, false), SCORE, "LOW", NOW);
  // TOKEN_B has no snapshot at all
  const m = getWalletIntelligence(WALLET, NOW + 60).metrics.unrealizedPnl;
  assert.equal(m.availability, "UNAVAILABLE");
  assert.equal(m.value, undefined);
  assert.match(m.reason!, /1 of 2/);
});

test("early entry timing is the median blocks from launch to first buy", () => {
  openPositionOn(TOKEN, 105); // 5 blocks after launch 100
  openPositionOn(TOKEN_B, 125); // 25 blocks after
  const m = getWalletIntelligence(WALLET, NOW).metrics.earlyEntryTiming;
  assert.equal(m.availability, "REAL");
  assert.equal(m.value, 15);
  assert.match(m.unit!, /blocks/);
});

test("early entry is UNAVAILABLE when FLETCH never saw a token from launch", () => {
  recordCurveScan(TOKEN, 100, 5000, 9000, [
    { wallet: WALLET, txHash: "0x01", logIndex: 0, blockNumber: 6000, side: "buy", tokenAmount: 1000, quoteAmount: 1 },
  ]);
  assert.equal(getWalletIntelligence(WALLET, NOW).metrics.earlyEntryTiming.availability, "UNAVAILABLE");
});
