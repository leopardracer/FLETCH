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

    -- Phase 4: one row per real CurveBuy/CurveSell, with the price implied
    -- by that exact trade (quote amount / token amount) — the price-at-trade
    -- that wallet_activity never had. UNIQUE(tx_hash, log_index) makes
    -- re-scanning the same blocks idempotent: a trade is only ever counted once.
    CREATE TABLE IF NOT EXISTS wallet_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet TEXT NOT NULL,
      token TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      block_number INTEGER NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
      token_amount REAL NOT NULL,
      quote_amount REAL NOT NULL,
      price_in_pair REAL NOT NULL,
      UNIQUE (tx_hash, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_trades_wallet ON wallet_trades(wallet, token, block_number, log_index);

    -- Which block ranges of a token's curve have actually been scanned for
    -- trades. PnL is only computed over the contiguous stretch starting at
    -- the token's launch block — a gap means a missed buy or sell, and a
    -- cost basis built on a missed trade would be wrong, not just imprecise.
    CREATE TABLE IF NOT EXISTS trade_scan_coverage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL,
      launch_block INTEGER NOT NULL,
      from_block INTEGER NOT NULL,
      to_block INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trade_scan_coverage_token ON trade_scan_coverage(token, from_block);

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

/** Closes the real (file-backed) database cleanly on shutdown — see
 *  index.ts's SIGTERM/SIGINT handler. A no-op if the db was never opened
 *  (e.g. RPC_URL unset, so getDb() was never called) or already closed;
 *  node:sqlite doesn't error on a redundant close, but this still guards
 *  it so shutdown logic never has to know which case it's in. */
export function closeDb(): void {
  if (!_db) return;
  _db.close();
  _db = null;
}

/** Test-only: point at a fresh in-memory database instead of the configured file. */
export function useInMemoryDbForTests(): DatabaseSync {
  _db = new DatabaseSync(":memory:");
  createSchema(_db);
  return _db;
}
