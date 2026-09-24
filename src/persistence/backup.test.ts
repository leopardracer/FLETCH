import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { useInMemoryDbForTests } from "./db.js";
import { saveReport } from "./reportStore.js";
import { runBackup, listBackups, backupDir } from "./backup.js";

beforeEach(() => { useInMemoryDbForTests(); });
const T0 = 1_790_000_000;

test("a snapshot is a complete, readable copy of the database", () => {
  saveReport("0x" + "a".repeat(40), { token: { symbol: "WALS" } }, T0);
  const dir = mkdtempSync(join(tmpdir(), "fletch-bk-"));
  const r = runBackup(T0, dir, 3)!;
  assert.match(r.file, /^fletch-2026-09-21T\d\d-\d\d-\d\dZ\.db$/);
  assert.ok(r.bytes > 0);
  const copy = new DatabaseSync(join(dir, r.file));
  const row = copy.prepare(`SELECT json_extract(report_json,'$.token.symbol') s FROM token_reports`).get() as { s: string };
  assert.equal(row.s, "WALS");
});

test("only the newest BACKUP_KEEP snapshots are kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "fletch-bk-"));
  const files = [0, 1, 2, 3].map((d) => runBackup(T0 + d * 86_400, dir, 2)!.file);
  const left = listBackups(dir).map((b) => b.file);
  assert.deepEqual(left, [files[3], files[2]], "newest first, two kept");
  assert.equal(existsSync(join(dir, files[0])), false);
});

test("running twice in the same second replaces that snapshot rather than failing", () => {
  const dir = mkdtempSync(join(tmpdir(), "fletch-bk-"));
  runBackup(T0, dir, 3);
  assert.doesNotThrow(() => runBackup(T0, dir, 3));
  assert.equal(listBackups(dir).length, 1);
});

test("an in-memory database has nowhere to back up to", () => {
  assert.equal(backupDir(":memory:"), null);
  assert.equal(runBackup(T0, null), null);
  assert.deepEqual(listBackups(null), []);
});
