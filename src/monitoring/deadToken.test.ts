import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { isDeadToken } from "./deadToken.js";
import { useInMemoryDbForTests } from "../persistence/db.js";
import { recordCurveScan } from "../persistence/walletTradesStore.js";
import { upsertDiscovered, getMonitoredToken, getDeadTokens } from "./monitoringStore.js";
import { runMonitoringCycle, type MonitoringDeps } from "./monitoringService.js";
import { getSignalsForToken } from "../persistence/signalsStore.js";
import { getReport } from "../persistence/reportStore.js";
import type { TokenMetrics } from "../data/types.js";
import type { DetectedLaunch } from "../chain/hunt.js";

const base = { deadLiquidityEth: 0.001, deadAfterBlocks: 50_000 };

test("dead: drained curve + no trade for DEAD_AFTER_BLOCKS", () => {
  assert.equal(isDeadToken({ ...base, metrics: { liquidityPairAsset: 0.00006, graduated: false }, lastTradeBlock: 1_000, scannedThroughBlock: 60_000 }), true);
});
test("not dead: traded recently, even with a drained curve", () => {
  assert.equal(isDeadToken({ ...base, metrics: { liquidityPairAsset: 0.00006, graduated: false }, lastTradeBlock: 55_000, scannedThroughBlock: 60_000 }), false);
});
test("not dead: real liquidity still in the curve", () => {
  assert.equal(isDeadToken({ ...base, metrics: { liquidityPairAsset: 2.5, graduated: false }, lastTradeBlock: 1_000, scannedThroughBlock: 60_000 }), false);
});
test("never dead on missing data or after graduation", () => {
  assert.equal(isDeadToken({ ...base, metrics: { liquidityPairAsset: null, graduated: false }, lastTradeBlock: 1, scannedThroughBlock: 99_999 }), false);
  assert.equal(isDeadToken({ ...base, metrics: { liquidityPairAsset: 0, graduated: false }, lastTradeBlock: null, scannedThroughBlock: 99_999 }), false);
  assert.equal(isDeadToken({ ...base, metrics: { liquidityPairAsset: 0, graduated: true }, lastTradeBlock: 1, scannedThroughBlock: 99_999 }), false);
});

// ---------- through a real monitoring cycle ----------
const NOW = 1_800_000_000;
const TOKEN = "0x00000000000000000000000000000000000d3ad0" as `0x${string}`;
function metrics(o: Partial<TokenMetrics> = {}): TokenMetrics {
  return { priceInPair: 1e-9, liquidityPairAsset: 0.00006, liquidityUsd: 0.18, holderCount: 0, holderCountIsLifetime: true, buyCountWindow: 15, sellCountWindow: 15,
    volumePairAssetWindow: 1, topHolderConcentrationPercent: null, whaleMoves: [], graduated: false, ...o } as TokenMetrics;
}
function deps(m: TokenMetrics): MonitoringDeps {
  return { scanLaunches: async () => [], getMetrics: async () => m,
    getSmartMoney: async () => ({ available: false, reason: "t" }), getSocial: async () => ({ available: false, reason: "t" }) } as MonitoringDeps;
}
const launch = { token: TOKEN, curve: "0x00000000000000000000000000000000000c0ffe", deployer: "0x00000000000000000000000000000000000000de",
  pairToken: "0x0000000000000000000000000000000000000000", graduationThreshold: 0n, launchBlock: 1_000n, launchTxHash: "0x1",
  devBuyTokens: null, devBuyTaxBps: null, exemptWalletCount: 0, deployerLaunchCountInWindow: 1, launchTimestamp: NOW - 86_400 } as unknown as DetectedLaunch;

beforeEach(() => {
  useInMemoryDbForTests();
  upsertDiscovered(TOKEN, NOW - 86_400, "HIGH", launch);
});

test("REGRESSION (live): a drained, inactive launch is marked DEAD — off the radar, no repeat signals, re-checked in hours", async () => {
  recordCurveScan(TOKEN, 1_000, 1_000, 200_000, [{ wallet: "0x00000000000000000000000000000000000000aa", txHash: "0xaa", logIndex: 0, blockNumber: 1_010, side: "sell", tokenAmount: 10, quoteAmount: 0.001 }]);
  await runMonitoringCycle(deps(metrics()), NOW, 5, 10);
  const m = getMonitoredToken(TOKEN)!;
  assert.equal(m.phase, "DEAD");
  assert.equal(m.priority, "LOW");
  assert.ok(m.nextCheckAt >= NOW + 6 * 3600 - 1);
  assert.equal(getSignalsForToken(TOKEN, 50).length, 0, "no 'liquidity is only $0' re-filed");
  assert.equal((getReport(TOKEN)!.report as { status?: string }).status, "DEAD");
  assert.ok(getDeadTokens().has(TOKEN.toLowerCase()));
});

test("a DEAD token that trades again comes back to CURVE on its next check", async () => {
  recordCurveScan(TOKEN, 1_000, 1_000, 200_000, [{ wallet: "0x00000000000000000000000000000000000000aa", txHash: "0xaa", logIndex: 0, blockNumber: 1_010, side: "sell", tokenAmount: 10, quoteAmount: 0.001 }]);
  await runMonitoringCycle(deps(metrics()), NOW, 5, 10);
  recordCurveScan(TOKEN, 1_000, 200_001, 210_000, [{ wallet: "0x00000000000000000000000000000000000000bb", txHash: "0xbb", logIndex: 0, blockNumber: 209_990, side: "buy", tokenAmount: 10, quoteAmount: 0.5 }]);
  await runMonitoringCycle(deps(metrics({ liquidityPairAsset: 0.5 })), NOW + 7 * 3600, 5, 10);
  assert.equal(getMonitoredToken(TOKEN)!.phase, "CURVE");
});
