import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useInMemoryDbForTests } from "../persistence/db.js";
import { recordWalletActivity } from "../persistence/walletActivityStore.js";
import { getWalletIntelligence } from "./walletScore.js";

const WALLET = "0xcccccccccccccccccccccccccccccccccccccccc" as const;
const TOKEN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const NOW = 1_700_000_000;

beforeEach(() => {
  useInMemoryDbForTests();
});

const NOT_IMPLEMENTED_METRICS = ["winRate", "earlyEntryTiming", "realizedPnl", "unrealizedPnl", "averageHoldingPeriod"] as const;

test("every skill/performance metric is explicitly NOT_YET_IMPLEMENTED with a stated reason — never a computed number", () => {
  const intel = getWalletIntelligence(WALLET);
  for (const key of NOT_IMPLEMENTED_METRICS) {
    assert.equal(intel.metrics[key].availability, "NOT_YET_IMPLEMENTED");
    assert.ok(intel.metrics[key].reason && intel.metrics[key].reason!.length > 0, `${key} must state why it isn't implemented`);
  }
});

test("this holds even for a wallet with a long, real recorded history — more data doesn't unlock a fabricated score", () => {
  for (let i = 0; i < 20; i++) recordWalletActivity(WALLET, TOKEN, 100, 1, NOW + i * 100);
  const intel = getWalletIntelligence(WALLET);
  for (const key of NOT_IMPLEMENTED_METRICS) {
    assert.equal(intel.metrics[key].availability, "NOT_YET_IMPLEMENTED");
  }
  // No overall numeric "wallet score" field exists on the type at all.
  assert.equal("walletScore" in intel, false);
  assert.equal("score" in intel, false);
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
