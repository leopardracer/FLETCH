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
      safety_score INTEGER,
      risk_level TEXT,
      graduated INTEGER
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

    -- Meme Radar candidates come from the signals table; this table is the
    -- durable monitoring queue itself — which tokens FLETCH is watching,
    -- and enough state about each to schedule the next check without
    -- re-deriving everything from a fresh chain scan every cycle. Survives
    -- process restart because it's just another SQLite table.
    -- launch_json caches the launch-moment facts (curve address, dev-buy
    -- data, etc.) captured once at discovery — these never change, so
    -- every later check reuses them instead of re-deriving them from raw
    -- chain logs on every single cycle like the original poller did.
    CREATE TABLE IF NOT EXISTS monitored_tokens (
      token TEXT PRIMARY KEY,
      first_detected_at INTEGER NOT NULL,
      last_checked_at INTEGER,
      last_success_at INTEGER,
      next_check_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      phase TEXT,
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      priority TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      launch_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_monitored_status_next_check ON monitored_tokens(status, next_check_at);
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
