import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useInMemoryDbForTests } from "../persistence/db.js";
import { upsertDiscovered, evictOneForNew, getMonitoredToken, recordCheckFailure, setPriority, countMonitored } from "./monitoringStore.js";
import { runDiscoveryCycle, type MonitoringDeps } from "./monitoringService.js";
import { RpcBackoff } from "../core/rpcBackoff.js";
import type { DetectedLaunch } from "../chain/hunt.js";

beforeEach(() => { useInMemoryDbForTests(); });
const NOW = 1_700_000_000;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;

test("never evicts HIGH or NORMAL active tokens", () => {
  upsertDiscovered(addr(1), NOW, "HIGH");
  upsertDiscovered(addr(2), NOW, "NORMAL");
  assert.equal(evictOneForNew(), false);
  assert.equal(countMonitored(), 2);
});

test("evicts FAILED before LOW-priority, and LOW before nothing", () => {
  upsertDiscovered(addr(1), NOW, "HIGH"); setPriority(addr(1), "LOW", NOW);
  upsertDiscovered(addr(2), NOW, "HIGH");
  for (let i = 0; i < 5; i++) recordCheckFailure(addr(2), "boom", NOW, NOW + 60, 5);
  assert.equal(evictOneForNew(), true);
  assert.equal(getMonitoredToken(addr(2)), null); // the FAILED one went first
  assert.ok(getMonitoredToken(addr(1)));
  assert.equal(evictOneForNew(), true);
  assert.equal(getMonitoredToken(addr(1)), null);
});

function launch(n: number): DetectedLaunch {
  return { token: addr(n), curve: addr(1000 + n), deployer: addr(2000), pairToken: addr(0), graduationThreshold: 0n, launchBlock: 1n, launchTxHash: "0x01",
    devBuyTokens: null, devBuyTaxBps: null, exemptWalletCount: 0, deployerLaunchCountInWindow: 1 } as unknown as DetectedLaunch;
}
function deps(ls: DetectedLaunch[]): MonitoringDeps {
  return { scanLaunches: async () => ls, getMetrics: async () => { throw new Error("unused"); },
    getSmartMoney: async () => ({ available: false, reason: "x" }), getSocial: async () => ({ available: false, reason: "x" }) } as MonitoringDeps;
}

test("REGRESSION: re-discovering already-watched tokens is not reported as 'skipped for capacity'", async () => {
  upsertDiscovered(addr(1), NOW, "HIGH");
  const r = await runDiscoveryCycle(deps([launch(1)]), NOW, new RpcBackoff(60, 3600));
  assert.equal(r.discovered, 0);
  assert.equal(r.skippedCapacity, 0);
});
