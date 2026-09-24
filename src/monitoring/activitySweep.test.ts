import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { useInMemoryDbForTests, getDb, migrateInPlace } from "../persistence/db.js";
import { upsertDiscovered, getMonitoredToken, getDueForCheck, setPriority } from "./monitoringStore.js";
import { recordCurveScan } from "../persistence/walletTradesStore.js";
import { runActivitySweep, resetSweepCursor, ADDRESSES_PER_CALL, QUIET_AFTER_SECONDS, type SweepDeps, type SweepLog } from "./activitySweep.js";
import { runDiscoveryCycle } from "./monitoringService.js";
import { RpcBackoff } from "../core/rpcBackoff.js";
import type { DetectedLaunch } from "../chain/hunt.js";

const NOW = 1_700_000_000;
const LOW_INTERVAL = 2400;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const curveOf = (n: number) => addr(9_000_000 + n);

function launch(n: number, launchBlock = 1000n): DetectedLaunch {
  return {
    token: addr(n), curve: curveOf(n), deployer: addr(8_000_000), pairToken: "0x0000000000000000000000000000000000000000",
    graduationThreshold: 1n, launchBlock, launchTxHash: "0xabc", devBuyTokens: 0, devBuyTaxBps: 0, exemptWalletCount: 0,
    deployerLaunchCountInWindow: 1, launchTimestamp: null,
  };
}
function watch(n: number, detectedAt = NOW, launchBlock = 1000n) {
  upsertDiscovered(addr(n), detectedAt, "NORMAL", launch(n, launchBlock), detectedAt + QUIET_AFTER_SECONDS);
}

/** A fake chain: logs are {curve, block}; records every getLogs call. */
function fakeChain(latest: bigint, logs: { curve: `0x${string}`; block: number }[]) {
  const calls: { addresses: string[]; from: bigint; to: bigint }[] = [];
  const deps: SweepDeps = {
    latestBlock: async () => latest,
    getLogs: async (addresses, from, to) => {
      calls.push({ addresses, from, to });
      const set = new Set(addresses.map((a) => a.toLowerCase()));
      return logs
        .filter((l) => set.has(l.curve.toLowerCase()) && BigInt(l.block) >= from && BigInt(l.block) <= to)
        .map((l): SweepLog => ({ address: l.curve, blockNumber: BigInt(l.block) }));
    },
  };
  return { deps, calls };
}

beforeEach(() => {
  useInMemoryDbForTests();
  resetSweepCursor(null);
});

test("a watched token with a new curve trade jumps to HIGH and is due now", async () => {
  watch(1);
  const { deps } = fakeChain(5000n, [{ curve: curveOf(1), block: 4990 }]);
  const r = await runActivitySweep(deps, NOW + 60, new RpcBackoff(30, 600), LOW_INTERVAL);
  assert.equal(r.promoted, 1);
  const t = getMonitoredToken(addr(1))!;
  assert.equal(t.priority, "HIGH");
  assert.equal(t.lastActivityBlock, 4990);
  assert.ok(t.nextCheckAt <= NOW + 60);
  assert.deepEqual(getDueForCheck(NOW + 60, 10).map((x) => x.token), [addr(1)]);
});

test("the dev buy in the launch block is not market activity", async () => {
  watch(1, NOW, 4990n);
  const { deps } = fakeChain(5000n, [{ curve: curveOf(1), block: 4990 }]);
  const r = await runActivitySweep(deps, NOW + 60, new RpcBackoff(30, 600), LOW_INTERVAL);
  assert.equal(r.promoted, 0);
  assert.equal(getMonitoredToken(addr(1))!.lastActivityBlock, null);
});

test("a new launch is not checked at discovery — its first full check waits for the quiet window", async () => {
  const r = await runDiscoveryCycle(
    { scanLaunches: async () => [launch(1)], getMetrics: async () => { throw new Error("no"); }, getSmartMoney: async () => { throw new Error("no"); }, getSocial: async () => { throw new Error("no"); } },
    NOW,
    new RpcBackoff(30, 600)
  );
  assert.equal(r.discovered, 1);
  const t = getMonitoredToken(addr(1))!;
  assert.equal(t.priority, "NORMAL");
  assert.equal(t.nextCheckAt, NOW + QUIET_AFTER_SECONDS);
  assert.equal(getDueForCheck(NOW, 10).length, 0);
});

test("a launch still quiet after its window drops to LOW before ever costing a full check; one that traded doesn't", async () => {
  watch(1); // never trades
  watch(2); // trades
  watch(3, NOW + QUIET_AFTER_SECONDS - 60); // too young to judge
  const { deps } = fakeChain(5000n, [{ curve: curveOf(2), block: 4999 }]);
  const at = NOW + QUIET_AFTER_SECONDS + 1;
  const r = await runActivitySweep(deps, at, new RpcBackoff(30, 600), LOW_INTERVAL);
  assert.equal(r.demoted, 1);
  assert.equal(getMonitoredToken(addr(1))!.priority, "LOW");
  assert.ok(getMonitoredToken(addr(1))!.nextCheckAt >= at + LOW_INTERVAL);
  assert.equal(getMonitoredToken(addr(2))!.priority, "HIGH");
  assert.equal(getMonitoredToken(addr(3))!.priority, "NORMAL");
});

test("a token with trades already recorded is never demoted as 'quiet'", async () => {
  watch(1);
  recordCurveScan(addr(1), 1000, 1000, 2000, [
    { wallet: addr(5), side: "buy", quoteAmount: 1, tokenAmount: 10, blockNumber: 1500, logIndex: 1, txHash: ("0x" + "1".repeat(64)) as `0x${string}` },
  ]);
  const { deps } = fakeChain(5000n, []);
  const r = await runActivitySweep(deps, NOW + QUIET_AFTER_SECONDS + 1, new RpcBackoff(30, 600), LOW_INTERVAL);
  assert.equal(r.demoted, 0);
});

test("a LOW (or dead) token that starts trading again is promoted straight back to HIGH", async () => {
  watch(1);
  setPriority(addr(1), "LOW", NOW);
  getDb().prepare(`UPDATE monitored_tokens SET next_check_at = ? WHERE token = ?`).run(NOW + 99_999, addr(1));
  const { deps } = fakeChain(5000n, [{ curve: curveOf(1), block: 4500 }]);
  await runActivitySweep(deps, NOW + 100, new RpcBackoff(30, 600), LOW_INTERVAL);
  const t = getMonitoredToken(addr(1))!;
  assert.equal(t.priority, "HIGH");
  assert.equal(t.nextCheckAt, NOW + 100);
});

test("curves are read in batches of 100 per call, and each sweep only reads blocks after the last one", async () => {
  for (let i = 1; i <= 250; i++) watch(i);
  const first = fakeChain(10_000n, []);
  await runActivitySweep(first.deps, NOW, new RpcBackoff(30, 600), LOW_INTERVAL);
  assert.equal(first.calls.length, 3);
  assert.deepEqual(first.calls.map((c) => c.addresses.length), [ADDRESSES_PER_CALL, ADDRESSES_PER_CALL, 50]);
  const second = fakeChain(10_240n, []);
  await runActivitySweep(second.deps, NOW + 60, new RpcBackoff(30, 600), LOW_INTERVAL);
  assert.equal(second.calls[0].from, 10_001n);
  assert.equal(second.calls[0].to, 10_240n);
});

test("a rate-limited sweep pauses, promotes nothing, demotes nothing, and re-reads the same blocks next time", async () => {
  watch(1);
  const backoff = new RpcBackoff(30, 600);
  resetSweepCursor(4000n);
  const limited: SweepDeps = {
    latestBlock: async () => 5000n,
    getLogs: async () => { throw Object.assign(new Error("HTTP request failed."), { status: 403 }); },
  };
  const r = await runActivitySweep(limited, NOW + QUIET_AFTER_SECONDS + 1, backoff, LOW_INTERVAL);
  assert.equal(r.paused, true);
  assert.equal(r.rateLimitStarted, true);
  assert.equal(r.demoted, 0, "a failed read is not evidence of 'no trades'");
  assert.equal(getMonitoredToken(addr(1))!.priority, "NORMAL");
  const again = fakeChain(5000n, []);
  await runActivitySweep(again.deps, NOW + QUIET_AFTER_SECONDS + 1000, new RpcBackoff(30, 600), LOW_INTERVAL);
  assert.equal(again.calls[0].from, 4001n);
});

test("an existing database gets the last_activity_block column added in place", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE monitored_tokens (token TEXT PRIMARY KEY, first_detected_at INTEGER NOT NULL, last_checked_at INTEGER, last_success_at INTEGER,
    next_check_at INTEGER NOT NULL, status TEXT NOT NULL, phase TEXT, failure_count INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    priority TEXT NOT NULL, updated_at INTEGER NOT NULL, launch_json TEXT)`);
  db.prepare(`INSERT INTO monitored_tokens VALUES ('0x1', 1, NULL, NULL, 1, 'ACTIVE', NULL, 0, NULL, 'HIGH', 1, NULL)`).run();
  const cols = () => (db.prepare(`PRAGMA table_info(monitored_tokens)`).all() as { name: string }[]).map((c) => c.name);
  assert.ok(!cols().includes("last_activity_block"));
  migrateInPlace(db);
  migrateInPlace(db); // idempotent
  assert.ok(cols().includes("last_activity_block"));
  assert.deepEqual(db.prepare(`SELECT token, last_activity_block FROM monitored_tokens`).all().map((r) => ({ ...r })), [{ token: "0x1", last_activity_block: null }], "existing rows kept");
});


test("the one-time clean-up keeps only the first row of each repeated whale transaction", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE monitored_tokens (token TEXT PRIMARY KEY, first_detected_at INTEGER NOT NULL, last_checked_at INTEGER, last_success_at INTEGER,
    next_check_at INTEGER NOT NULL, status TEXT NOT NULL, phase TEXT, failure_count INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    priority TEXT NOT NULL, updated_at INTEGER NOT NULL, launch_json TEXT)`);
  db.exec(`CREATE TABLE signals (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT, type TEXT, severity TEXT, confidence INTEGER, evidence TEXT, explanation TEXT, block_number TEXT, taken_at INTEGER)`);
  const ins = db.prepare(`INSERT INTO signals (token,type,severity,confidence,evidence,explanation,block_number,taken_at) VALUES (?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < 5; i++) ins.run("0xa", "WHALE_SELL_TO_CURVE", "MEDIUM", 75, "tx 0x01", "x", "1", 100 + i);
  ins.run("0xa", "WHALE_SELL_TO_CURVE", "MEDIUM", 75, "tx 0x02", "x", "2", 200);
  ins.run("0xa", "BUY_PRESSURE", "LOW", 60, "10 buys vs 1 sells", "x", null, 300);
  ins.run("0xa", "BUY_PRESSURE", "LOW", 60, "10 buys vs 1 sells", "x", null, 400);
  migrateInPlace(db);
  const rows = db.prepare(`SELECT type, evidence, taken_at FROM signals ORDER BY id`).all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { type: "WHALE_SELL_TO_CURVE", evidence: "tx 0x01", taken_at: 100 },
    { type: "WHALE_SELL_TO_CURVE", evidence: "tx 0x02", taken_at: 200 },
    { type: "BUY_PRESSURE", evidence: "10 buys vs 1 sells", taken_at: 300 },
    { type: "BUY_PRESSURE", evidence: "10 buys vs 1 sells", taken_at: 400 },
  ], "trend signals are untouched");
  ins.run("0xa", "WHALE_SELL_TO_CURVE", "MEDIUM", 75, "tx 0x01", "x", "1", 500);
  migrateInPlace(db);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM signals`).get()!.n, 5, "runs once (user_version), never again");
});
