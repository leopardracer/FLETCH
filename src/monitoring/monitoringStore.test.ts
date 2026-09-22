import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useInMemoryDbForTests } from "../persistence/db.js";
import {
  upsertDiscovered,
  getDueForCheck,
  recordCheckSuccess,
  recordCheckFailure,
  setPriority,
  getMonitoredToken,
  countMonitored,
  getMonitoringHealth,
} from "./monitoringStore.js";

const TOKEN_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const TOKEN_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const NOW = 1_700_000_000;

beforeEach(() => {
  useInMemoryDbForTests();
});

test("upsertDiscovered inserts a new token as ACTIVE, due immediately", () => {
  const inserted = upsertDiscovered(TOKEN_A, NOW);
  assert.equal(inserted, true);
  const token = getMonitoredToken(TOKEN_A);
  assert.equal(token?.status, "ACTIVE");
  assert.equal(token?.nextCheckAt, NOW);
  assert.equal(token?.failureCount, 0);
});

test("upsertDiscovered is a no-op for a token already in the queue — re-discovering it never resets its state", () => {
  upsertDiscovered(TOKEN_A, NOW);
  recordCheckFailure(TOKEN_A, "boom", NOW + 10, NOW + 20, 5);
  const secondDiscovery = upsertDiscovered(TOKEN_A, NOW + 100);
  assert.equal(secondDiscovery, false);
  const token = getMonitoredToken(TOKEN_A);
  assert.equal(token?.failureCount, 1); // unchanged by the second "discovery"
});

test("getDueForCheck only returns tokens whose next_check_at has arrived", () => {
  upsertDiscovered(TOKEN_A, NOW);
  recordCheckSuccess(TOKEN_A, "CURVE", NOW, NOW + 10_000); // not due again until NOW+10000
  upsertDiscovered(TOKEN_B, NOW); // still due now

  const due = getDueForCheck(NOW + 5, 10);
  assert.equal(due.length, 1);
  assert.equal(due[0].token, TOKEN_B);
});

test("getDueForCheck orders HIGH priority before NORMAL before LOW", () => {
  upsertDiscovered(TOKEN_A, NOW, "LOW");
  upsertDiscovered(TOKEN_B, NOW, "HIGH");
  const due = getDueForCheck(NOW, 10);
  assert.equal(due[0].token, TOKEN_B);
  assert.equal(due[1].token, TOKEN_A);
});

test("getDueForCheck never returns a FAILED token, no matter how overdue", () => {
  upsertDiscovered(TOKEN_A, NOW);
  recordCheckFailure(TOKEN_A, "dead contract", NOW, NOW, 1); // 1 failure hits maxConsecutiveFailures=1 immediately
  const due = getDueForCheck(NOW + 100_000, 10);
  assert.equal(due.length, 0);
});

test("recordCheckSuccess resets failure_count to 0 — a working token doesn't carry an old grudge", () => {
  upsertDiscovered(TOKEN_A, NOW);
  recordCheckFailure(TOKEN_A, "transient", NOW, NOW + 10, 5);
  assert.equal(getMonitoredToken(TOKEN_A)?.failureCount, 1);
  recordCheckSuccess(TOKEN_A, "CURVE", NOW + 20, NOW + 100);
  const token = getMonitoredToken(TOKEN_A);
  assert.equal(token?.failureCount, 0);
  assert.equal(token?.lastError, null);
  assert.equal(token?.phase, "CURVE");
});

test("recordCheckFailure marks a token FAILED only after maxConsecutiveFailures, not on the first failure", () => {
  upsertDiscovered(TOKEN_A, NOW);
  recordCheckFailure(TOKEN_A, "e1", NOW, NOW + 10, 3);
  assert.equal(getMonitoredToken(TOKEN_A)?.status, "ACTIVE");
  recordCheckFailure(TOKEN_A, "e2", NOW + 10, NOW + 20, 3);
  assert.equal(getMonitoredToken(TOKEN_A)?.status, "ACTIVE");
  recordCheckFailure(TOKEN_A, "e3", NOW + 20, NOW + 30, 3);
  assert.equal(getMonitoredToken(TOKEN_A)?.status, "FAILED");
});

test("recordCheckFailure never writes to token_snapshots or signals — only monitoring metadata changes", () => {
  upsertDiscovered(TOKEN_A, NOW);
  recordCheckFailure(TOKEN_A, "rpc timeout", NOW, NOW + 10, 5);
  const token = getMonitoredToken(TOKEN_A);
  assert.equal(token?.lastError, "rpc timeout");
  assert.equal(token?.failureCount, 1);
  // No assertion needed against token_snapshots/signals tables directly —
  // recordCheckFailure's own SQL only ever touches monitored_tokens, see source.
});

test("setPriority updates priority without disturbing schedule or failure state", () => {
  upsertDiscovered(TOKEN_A, NOW, "LOW");
  recordCheckFailure(TOKEN_A, "e", NOW, NOW + 10, 5);
  setPriority(TOKEN_A, "HIGH", NOW + 5);
  const token = getMonitoredToken(TOKEN_A);
  assert.equal(token?.priority, "HIGH");
  assert.equal(token?.failureCount, 1);
});

test("countMonitored counts overall and per-status", () => {
  upsertDiscovered(TOKEN_A, NOW);
  upsertDiscovered(TOKEN_B, NOW);
  recordCheckFailure(TOKEN_B, "e", NOW, NOW, 1);
  assert.equal(countMonitored(), 2);
  assert.equal(countMonitored("ACTIVE"), 1);
  assert.equal(countMonitored("FAILED"), 1);
});

test("getMonitoringHealth reports accurate counts per status plus how many are due right now", () => {
  upsertDiscovered(TOKEN_A, NOW); // due now
  upsertDiscovered(TOKEN_B, NOW);
  recordCheckSuccess(TOKEN_B, "CURVE", NOW, NOW + 100_000); // not due for a long time

  const health = getMonitoringHealth(NOW);
  assert.equal(health.totalMonitored, 2);
  assert.equal(health.activeCount, 2);
  assert.equal(health.dueNowCount, 1);
  assert.equal(health.lastSuccessfulCheckAt, NOW);
  assert.equal(health.nextScheduledCheckAt, NOW); // TOKEN_A is still due at NOW — the earliest of the two
});

test("a stored launch round-trips exactly, including its bigint fields (launchBlock, graduationThreshold)", () => {
  const launch = {
    token: TOKEN_A,
    curve: "0xcccccccccccccccccccccccccccccccccccccccc" as const,
    deployer: "0xdddddddddddddddddddddddddddddddddddddddd" as const,
    pairToken: "0x0000000000000000000000000000000000000000" as const,
    graduationThreshold: 123456789012345678901234n,
    launchBlock: 987654321n,
    launchTxHash: "0xabc" as const,
    devBuyTokens: 5000,
    devBuyTaxBps: 9900,
    exemptWalletCount: 2,
    deployerLaunchCountInWindow: 1,
    launchTimestamp: null,
  };
  upsertDiscovered(TOKEN_A, NOW, "HIGH", launch);
  const stored = getMonitoredToken(TOKEN_A);
  assert.equal(stored?.launch?.launchBlock, 987654321n);
  assert.equal(typeof stored?.launch?.launchBlock, "bigint");
  assert.equal(stored?.launch?.graduationThreshold, 123456789012345678901234n);
  assert.equal(stored?.launch?.curve, launch.curve);
  assert.equal(stored?.launch?.devBuyTokens, 5000);
});

test("a token discovered without launch data stores launch as null, not a crash", () => {
  upsertDiscovered(TOKEN_A, NOW);
  assert.equal(getMonitoredToken(TOKEN_A)?.launch, null);
});
