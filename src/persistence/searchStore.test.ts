import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useInMemoryDbForTests } from "./db.js";
import { saveReport } from "./reportStore.js";
import { saveLaunchRecord } from "./launchRegistry.js";
import { searchTokens, isKnownToken, isFullAddress } from "./searchStore.js";

beforeEach(() => { useInMemoryDbForTests(); });

const A = "0x4f9e000000000000000000000000000000081a4";
const B = "0x4f9e111111111111111111111111111111111111";
const C = "0xcccccccccccccccccccccccccccccccccccccccc";

function report(sym: string | null, name: string | null, extra: Record<string, unknown> = {}) {
  return { token: { address: "x", symbol: sym, name }, fletchScore: { overall: 61 }, risk: { level: "MEDIUM" }, metrics: { holderCount: 212 }, ...extra };
}

test("finds by symbol, case-insensitive, with or without the $ — exact match first", () => {
  saveReport(A + "0", report("WALSH", "Walsh Coin"), 100);
  saveReport(B, report("WALS", "Wals"), 50);
  const hits = searchTokens("$wals");
  assert.equal(hits[0].symbol, "WALS", "exact symbol ranks above a longer symbol that merely starts with it");
  assert.equal(hits.length, 2);
  assert.equal(hits[0].score, 61);
  assert.equal(hits[0].riskLevel, "MEDIUM");
  assert.equal(hits[0].holders, 212);
});

test("finds by name, and marks dead launches", () => {
  saveReport(C, report("RUG", "Rug Cat", { status: "DEAD" }), 100);
  const hits = searchTokens("rug c");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].dead, true);
});

test("an address prefix matches reported tokens and registered-but-unreported launches", () => {
  saveReport(B, report("WALS", null), 100);
  saveLaunchRecord({
    found: true, token: A as `0x${string}`, curve: C as `0x${string}`, deployer: C as `0x${string}`, pairToken: C as `0x${string}`,
    launchConfigId: 1n, graduationThreshold: 1n, launchBlock: 10n, launchTxHash: ("0x" + "a".repeat(64)) as `0x${string}`,
  } as never);
  const hits = searchTokens("0x4F9E");
  assert.deepEqual(hits.map((h) => h.token).sort(), [A.toLowerCase(), B.toLowerCase()].sort());
  assert.equal(hits.find((h) => h.token === A.toLowerCase())!.symbol, null);
});

test("LIKE wildcards in a query are literal — '%' does not match everything", () => {
  saveReport(C, report("CAT", "Cat"), 100);
  assert.equal(searchTokens("%").length, 0);
  assert.equal(searchTokens("_").length, 0);
});

test("empty query → nothing; limit is capped", () => {
  for (let i = 0; i < 30; i++) saveReport("0x" + i.toString(16).padStart(40, "0"), report("CAT" + i, null), i);
  assert.equal(searchTokens("   ").length, 0);
  assert.equal(searchTokens("cat", 100).length, 20);
});

test("isKnownToken / isFullAddress", () => {
  assert.equal(isKnownToken(C), false);
  saveReport(C, report("CAT", null), 1);
  assert.equal(isKnownToken(C.toUpperCase().replace("0X", "0x")), true);
  assert.equal(isFullAddress(C), true);
  assert.equal(isFullAddress("0x1234"), false);
});
