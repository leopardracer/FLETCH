import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useInMemoryDbForTests, getDb } from "./db.js";
import { saveLaunchRecord } from "./launchRegistry.js";
import { saveReport } from "./reportStore.js";
import { upsertDiscovered, recordCheckSuccess } from "../monitoring/monitoringStore.js";
import { getDeployerProfile, getTokenDeployer, outcomeOf } from "./deployerStore.js";

beforeEach(() => { useInMemoryDbForTests(); });

const DEV = "0xDeaDDeaDdeaDdEAdDeaDDeADdeadDEaDDEADdEaD" as const;
const OTHER = "0x9999999999999999999999999999999999999999" as const;
const tok = (i: number) => (`0x${i.toString(16).padStart(40, "0")}`) as `0x${string}`;

function launch(token: `0x${string}`, deployer: `0x${string}`, block: number) {
  saveLaunchRecord({
    found: true, token, curve: token, deployer, pairToken: "0x0000000000000000000000000000000000000000",
    launchConfigId: 1n, graduationThreshold: 1n, launchBlock: BigInt(block), launchTxHash: ("0x" + "e".repeat(64)) as `0x${string}`,
  });
}
function report(token: `0x${string}`, r: { symbol?: string; score?: number | null; risk?: string; dead?: boolean; graduated?: boolean }) {
  saveReport(token, {
    token: { address: token, symbol: r.symbol ?? null, name: null, contractExists: true },
    ...(r.dead ? { status: "DEAD" } : {}),
    metrics: { graduated: r.graduated ?? false },
    risk: { level: r.risk ?? "LOW" },
    fletchScore: { overall: r.score ?? null },
  });
}
function phase(token: `0x${string}`, p: "CURVE" | "GRADUATED" | "DEAD") {
  upsertDiscovered(token, 1);
  recordCheckSuccess(token, p, 2, 3);
}

test("unknown address → empty profile, null rates, honest coverage note", () => {
  const p = getDeployerProfile(DEV);
  assert.equal(p.summary.launches, 0);
  assert.equal(p.summary.deadRatePct, null);
  assert.equal(p.summary.avgScore, null);
  assert.equal(p.summary.firstLaunchBlock, null);
  assert.deepEqual(p.launches, []);
  assert.match(p.coverage, /registered/);
});

test("groups launches by deployer, case-insensitively, newest first", () => {
  launch(tok(1), DEV, 100);
  launch(tok(2), DEV.toLowerCase() as `0x${string}`, 300);
  launch(tok(3), OTHER, 200);
  const p = getDeployerProfile(DEV.toUpperCase().replace("0X", "0x"));
  assert.equal(p.deployer, DEV.toLowerCase());
  assert.deepEqual(p.launches.map((l) => l.token), [tok(2), tok(1)]);
  assert.equal(p.summary.firstLaunchBlock, 100);
  assert.equal(p.summary.lastLaunchBlock, 300);
});

test("outcomes: graduated, dead, live, unchecked, and rates over checked launches only", () => {
  launch(tok(1), DEV, 1); phase(tok(1), "GRADUATED");
  launch(tok(2), DEV, 2); phase(tok(2), "DEAD");
  launch(tok(3), DEV, 3); report(tok(3), { dead: true, symbol: "RUG", score: 12, risk: "HIGH" });
  launch(tok(4), DEV, 4); phase(tok(4), "CURVE"); report(tok(4), { symbol: "LIVE", score: 60 });
  launch(tok(5), DEV, 5); // never checked
  const s = getDeployerProfile(DEV).summary;
  assert.deepEqual([s.launches, s.graduated, s.dead, s.live, s.unchecked], [5, 1, 2, 1, 1]);
  assert.equal(s.deadRatePct, 50);
  assert.equal(s.graduatedRatePct, 25);
  assert.equal(s.avgScore, 36);
  const rug = getDeployerProfile(DEV).launches.find((l) => l.token === tok(3))!;
  assert.deepEqual([rug.symbol, rug.outcome, rug.score, rug.riskLevel], ["RUG", "DEAD", 12, "HIGH"]);
});

test("a report saying graduated wins over a stale CURVE phase", () => {
  assert.equal(outcomeOf({ phase: "CURVE", status: null, graduated: 1, has_report: 1 }), "GRADUATED");
  assert.equal(outcomeOf({ phase: null, status: null, graduated: 0, has_report: 0 }), "UNCHECKED");
});

test("limit caps the list but not the summary", () => {
  for (let i = 1; i <= 7; i++) launch(tok(i), DEV, i);
  const p = getDeployerProfile(DEV, 3);
  assert.equal(p.launches.length, 3);
  assert.equal(p.truncated, true);
  assert.equal(p.summary.launches, 7);
});

test("getTokenDeployer: deployer and launch count, null for unregistered tokens", () => {
  launch(tok(1), DEV, 1); launch(tok(2), DEV, 2); launch(tok(3), OTHER, 3);
  assert.deepEqual(getTokenDeployer(tok(2)), { address: DEV.toLowerCase(), launches: 2 });
  assert.equal(getTokenDeployer(tok(42)), null);
});

test("the deployer lookup uses the expression index", () => {
  const plan = getDb()
    .prepare(`EXPLAIN QUERY PLAN SELECT token FROM launch_records WHERE lower(json_extract(record_json, '$.deployer')) = ?`)
    .all("0x1") as { detail: string }[];
  assert.ok(plan.some((p) => p.detail.includes("idx_launch_records_deployer")), JSON.stringify(plan));
});
