import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useInMemoryDbForTests } from "./db.js";
import { saveReport, getReport, listReports } from "./reportStore.js";

beforeEach(() => { useInMemoryDbForTests(); });
const T = "0xAAAAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("a saved report round-trips exactly, keyed case-insensitively, bigints made JSON-safe", () => {
  saveReport(T, { token: { symbol: "WALS" }, n: 5n }, 1000);
  const r = getReport(T.toLowerCase())!;
  assert.equal(r.takenAt, 1000);
  assert.deepEqual(r.report, { token: { symbol: "WALS" }, n: "5" });
});

test("saving again replaces the report (one row per token, latest wins)", () => {
  saveReport(T, { v: 1 }, 1000);
  saveReport(T, { v: 2 }, 2000);
  assert.deepEqual(getReport(T)!.report, { v: 2 });
  assert.equal(listReports(0, 10).length, 1);
});

test("listReports: newest first, only newer than the cutoff", () => {
  saveReport("0x" + "1".repeat(40), { a: 1 }, 100);
  saveReport("0x" + "2".repeat(40), { a: 2 }, 300);
  saveReport("0x" + "3".repeat(40), { a: 3 }, 200);
  assert.deepEqual(listReports(150, 10).map((r) => r.takenAt), [300, 200]);
});

test("no report → null, never an empty object", () => {
  assert.equal(getReport(T), null);
});
