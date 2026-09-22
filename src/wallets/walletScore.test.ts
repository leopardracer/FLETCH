import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useInMemoryDbForTests } from "../persistence/db.js";
import { recordWalletActivity } from "../persistence/walletActivityStore.js";
import { recordCurveScan } from "../persistence/walletTradesStore.js";
import { getWalletIntelligence } from "./walletScore.js";

const WALLET = "0xcccccccccccccccccccccccccccccccccccccccc" as const;
const TOKEN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const TOKEN_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const NOW = 1_700_000_000;

beforeEach(() => {
  useInMemoryDbForTests();
});

const STILL_NOT_IMPLEMENTED = ["earlyEntryTiming", "unrealizedPnl", "averageHoldingPeriod"] as const;

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
