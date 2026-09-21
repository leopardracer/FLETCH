import { getDb } from "./db.js";
import type { TokenMetrics } from "../data/types.js";
import type { FletchScore } from "../scoring/fletchScore.js";
import type { RiskLevel } from "../risk/riskAnalysis.js";
import { config } from "../core/config.js";

export interface TokenSnapshot {
  takenAt: number; // unix seconds
  priceInPair: number | null;
  liquidityUsd: number | null;
  holderCount: number | null;
  buyCountWindow: number;
  sellCountWindow: number;
  volumePairAssetWindow: number | null;
  topHolderConcentrationPercent: number | null;
  fletchScore: number | null;
  momentumScore: number | null;
  liquidityScore: number | null;
  holderGrowthScore: number | null;
  whaleActivityScore: number | null;
  safetyScore: number | null;
  /** The categorical risk level at this snapshot — added for Meme Radar,
   *  which needs a real risk level without a live chain call. Nullable
   *  because snapshots recorded before this field existed won't have it. */
  riskLevel: RiskLevel | null;
  /** null = unknown (no launch record found). Persisted so change-detection
   *  can tell a real metric shift apart from one caused by the token
   *  graduating between two snapshots — see signals/signalEngine.ts and
   *  docs/MONITORING.md. */
  graduated: boolean | null;
}

/**
 * Records a point-in-time snapshot for a token. Called on every token-page
 * read and by the optional background poller (see index.ts) — this is
 * what lets holder-growth *rate*, liquidity-change, and activity-
 * acceleration signals exist at all (see signals/signalEngine.ts). Rate-
 * limited by SNAPSHOT_MIN_INTERVAL_SECONDS so rapid repeat page views
 * don't spam near-duplicate rows.
 *
 * Returns whether a row was actually inserted — signalService.ts uses
 * this to skip re-persisting the same signals on a read that didn't
 * produce a new snapshot, which would otherwise duplicate identical
 * signal rows on every rapid repeat read (caught by
 * signals/signalService.test.ts).
 */
export function recordSnapshot(
  token: `0x${string}`,
  metrics: TokenMetrics,
  score: FletchScore,
  riskLevel: RiskLevel,
  now: number = Math.floor(Date.now() / 1000)
): boolean {
  const db = getDb();

  const last = db
    .prepare(`SELECT taken_at FROM token_snapshots WHERE token = ? ORDER BY taken_at DESC LIMIT 1`)
    .get(token.toLowerCase()) as { taken_at: number } | undefined;
  if (last && now - last.taken_at < config.snapshotMinIntervalSeconds) return false;

  db.prepare(
    `INSERT INTO token_snapshots
      (token, taken_at, price_in_pair, liquidity_usd, holder_count, buy_count_window, sell_count_window,
       volume_pair_asset_window, top_holder_concentration_pct, fletch_score, momentum_score, liquidity_score,
       holder_growth_score, whale_activity_score, safety_score, risk_level, graduated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    token.toLowerCase(),
    now,
    metrics.priceInPair,
    metrics.liquidityUsd,
    metrics.holderCount,
    metrics.buyCountWindow,
    metrics.sellCountWindow,
    metrics.volumePairAssetWindow,
    metrics.topHolderConcentrationPercent,
    score.overall,
    score.components.momentum.value,
    score.components.liquidity.value,
    score.components.holderGrowth.value,
    score.components.whaleActivity.value,
    score.components.safety.value,
    riskLevel,
    metrics.graduated === null ? null : metrics.graduated ? 1 : 0
  );
  return true;
}

/** Most recent snapshot strictly older than `olderThanSeconds` ago — the comparison point for trend signals. */
/** Raw shape of a `token_snapshots` row as `node:sqlite` returns it —
 *  snake_case columns, `graduated` as SQLite's 0/1/NULL rather than a real
 *  boolean. Exists purely so rowToSnapshot (and its three call sites
 *  below) can be typed instead of casting through `any`. */
interface SnapshotRow {
  taken_at: number;
  price_in_pair: number | null;
  liquidity_usd: number | null;
  holder_count: number | null;
  buy_count_window: number;
  sell_count_window: number;
  volume_pair_asset_window: number | null;
  top_holder_concentration_pct: number | null;
  fletch_score: number | null;
  momentum_score: number | null;
  liquidity_score: number | null;
  holder_growth_score: number | null;
  whale_activity_score: number | null;
  safety_score: number | null;
  risk_level: RiskLevel | null;
  graduated: number | null;
}

export function getPreviousSnapshot(
  token: `0x${string}`,
  olderThanSeconds: number,
  now: number = Math.floor(Date.now() / 1000)
): TokenSnapshot | null {
  const db = getDb();
  const cutoff = now - olderThanSeconds;
  const row = db
    .prepare(
      `SELECT * FROM token_snapshots WHERE token = ? AND taken_at <= ? ORDER BY taken_at DESC LIMIT 1`
    )
    .get(token.toLowerCase(), cutoff) as SnapshotRow | undefined;
  if (!row) return null;
  return rowToSnapshot(row);
}

/** Full recent history for a token, most recent first — feeds the score-history view. */
export function getSnapshotHistory(token: `0x${string}`, limit = 50): TokenSnapshot[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM token_snapshots WHERE token = ? ORDER BY taken_at DESC LIMIT ?`)
    .all(token.toLowerCase(), limit) as unknown as SnapshotRow[];
  return rows.map(rowToSnapshot);
}

/** The single most recent snapshot for a token, regardless of age — Meme
 *  Radar's source for FLETCH Score, risk level, and key metrics without a
 *  live chain call. Null if this token has never been checked. */
export function getLatestSnapshot(token: `0x${string}`): TokenSnapshot | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM token_snapshots WHERE token = ? ORDER BY taken_at DESC LIMIT 1`)
    .get(token.toLowerCase()) as SnapshotRow | undefined;
  return row ? rowToSnapshot(row) : null;
}

/** Deletes snapshots older than `cutoffTimestamp` across every token — the
 *  bounded-storage side of SNAPSHOT_RETENTION_DAYS. Returns the number of
 *  rows removed. Never touches anything at or after the cutoff. */
export function pruneSnapshotsOlderThan(cutoffTimestamp: number): number {
  const db = getDb();
  const result = db.prepare(`DELETE FROM token_snapshots WHERE taken_at < ?`).run(cutoffTimestamp);
  return Number(result.changes);
}

/** How many snapshots (across every token) were taken at or after
 *  `sinceTimestamp` — feeds GET /api/monitoring's "recent activity" view. */
export function countSnapshotsSince(sinceTimestamp: number): number {
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) as n FROM token_snapshots WHERE taken_at >= ?`).get(sinceTimestamp) as { n: number };
  return row.n;
}

function rowToSnapshot(row: SnapshotRow): TokenSnapshot {
  return {
    takenAt: row.taken_at,
    priceInPair: row.price_in_pair,
    liquidityUsd: row.liquidity_usd,
    holderCount: row.holder_count,
    buyCountWindow: row.buy_count_window,
    sellCountWindow: row.sell_count_window,
    volumePairAssetWindow: row.volume_pair_asset_window,
    topHolderConcentrationPercent: row.top_holder_concentration_pct,
    fletchScore: row.fletch_score,
    momentumScore: row.momentum_score,
    liquidityScore: row.liquidity_score,
    holderGrowthScore: row.holder_growth_score,
    whaleActivityScore: row.whale_activity_score,
    safetyScore: row.safety_score,
    riskLevel: row.risk_level ?? null,
    graduated: row.graduated === null || row.graduated === undefined ? null : !!row.graduated,
  };
}
