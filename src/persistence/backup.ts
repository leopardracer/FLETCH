import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDb } from "./db.js";
import { config } from "../core/config.js";

/**
 * Database snapshots. Everything FLETCH has learned — the permanent launch
 * registry, lifetime holder balances, every curve trade with its price —
 * lives in one SQLite file on one volume. This keeps a few consistent
 * copies of it:
 *
 *  - `VACUUM INTO` writes a complete, consistent copy while the app keeps
 *    running (a raw file copy of a live SQLite database can be torn).
 *  - Snapshots go to backups/ next to the database, named by UTC time,
 *    and only the newest BACKUP_KEEP are kept.
 *  - The same-volume copies protect against a bad migration, a bug that
 *    writes garbage, or a corrupted file. They do NOT protect against
 *    losing the volume itself — for that, Railway's own volume backups
 *    (Backups tab) and pulling a copy off the server with
 *    GET /api/admin/backup (BACKUP_TOKEN) are the other two layers.
 */

export interface BackupFile {
  file: string;
  path: string;
  bytes: number;
  createdAt: number; // unix seconds
}

const PREFIX = "fletch-";
const SUFFIX = ".db";

export function backupDir(dbPath: string = config.dbPath): string | null {
  if (!dbPath || dbPath === ":memory:") return null;
  return join(dirname(dbPath), "backups");
}

function stamp(now: number): string {
  return new Date(now * 1000).toISOString().replace(/[:]/g, "-").replace(/\.\d+Z$/, "Z"); // 2026-09-24T18-00-00Z
}

export function listBackups(dir: string | null = backupDir()): BackupFile[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith(SUFFIX))
    .map((f) => {
      const path = join(dir, f);
      const st = statSync(path);
      return { file: f, path, bytes: st.size, createdAt: Math.floor(st.mtimeMs / 1000) };
    })
    .sort((a, b) => (a.file < b.file ? 1 : -1)); // newest first (names sort by time)
}

export interface BackupResult {
  file: string;
  bytes: number;
  removed: string[];
}

export function runBackup(
  now: number = Math.floor(Date.now() / 1000),
  dir: string | null = backupDir(),
  keep: number = config.backupKeep
): BackupResult | null {
  if (!dir) return null; // in-memory database: nothing to back up
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${PREFIX}${stamp(now)}${SUFFIX}`);
  if (existsSync(path)) unlinkSync(path); // VACUUM INTO refuses to overwrite
  getDb().prepare(`VACUUM INTO ?`).run(path);
  const all = listBackups(dir);
  const removed = all.slice(Math.max(1, keep)).map((b) => {
    unlinkSync(b.path);
    return b.file;
  });
  return { file: path.split("/").pop()!, bytes: statSync(path).size, removed };
}
