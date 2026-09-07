import { DatabaseSync } from "node:sqlite";
import { config } from "../core/config.js";

/**
 * The "simplest production-appropriate persistence layer" the brief asks
 * for: Node's built-in node:sqlite (stable API surface, no extra runtime
 * dependency — still 5 deps in package.json, this adds zero). It IS
 * labeled experimental by Node itself as of this Node version; that's a
 * real caveat, not a hidden one — see docs/ARCHITECTURE.md. Swapping to
 * Postgres or better-sqlite3 later is a small, contained change: every
 * consumer goes through persistence/snapshots.ts, persistence/signalsStore.ts,
 * and persistence/walletActivityStore.ts, never this file directly.
 */

let _db: DatabaseSync | null = null;

function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL,
      taken_at INTEGER NOT NULL,
      price_in_pair REAL,
      liquidity_usd REAL,
      holder_count INTEGER,
      buy_count_window INTEGER NOT NULL,
      sell_count_window INTEGER NOT NULL,
      volume_pair_asset_window REAL,
      top_holder_concentration_pct REAL,
      fletch_score INTEGER,
      momentum_score INTEGER,
      liquidity_score INTEGER,
      holder_growth_score INTEGER,
      whale_activity_score INTEGER,
      safety_score INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_token_time ON token_snapshots(token, taken_at);

    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      confidence INTEGER NOT NULL,
      evidence TEXT NOT NULL,
      explanation TEXT NOT NULL,
      block_number TEXT,
      taken_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_signals_time ON signals(taken_at);
    CREATE INDEX IF NOT EXISTS idx_signals_token ON signals(token, taken_at);

    CREATE TABLE IF NOT EXISTS wallet_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet TEXT NOT NULL,
      token TEXT NOT NULL,
      taken_at INTEGER NOT NULL,
      net_change REAL NOT NULL,
      price_in_pair REAL
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_activity_wallet ON wallet_activity(wallet, taken_at);
    CREATE INDEX IF NOT EXISTS idx_wallet_activity_token ON wallet_activity(token, taken_at);
  `);
}

export function getDb(): DatabaseSync {
  if (_db) return _db;
  _db = new DatabaseSync(config.dbPath);
  createSchema(_db);
  return _db;
}

/** Test-only: point at a fresh in-memory database instead of the configured file. */
export function useInMemoryDbForTests(): DatabaseSync {
  _db = new DatabaseSync(":memory:");
  createSchema(_db);
  return _db;
}
