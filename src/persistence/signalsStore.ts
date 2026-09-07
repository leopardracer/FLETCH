import { getDb } from "./db.js";
import type { Signal } from "../signals/types.js";

export function recordSignal(token: `0x${string}`, signal: Signal): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO signals (token, type, severity, confidence, evidence, explanation, block_number, taken_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    token.toLowerCase(),
    signal.type,
    signal.severity,
    signal.confidence,
    signal.evidence,
    signal.explanation,
    signal.blockNumber ?? null,
    signal.timestamp
  );
}

export interface StoredSignal extends Signal {
  token: string;
}

/** Chain-wide recent signals for the live feed, most severe + most recent first. */
export function getRecentSignals(limit = 50): StoredSignal[] {
  const db = getDb();
  const severityRank = `CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END`;
  const rows = db
    .prepare(`SELECT * FROM signals ORDER BY ${severityRank} ASC, taken_at DESC LIMIT ?`)
    .all(limit) as any[];
  return rows.map(rowToSignal);
}

export function getSignalsForToken(token: `0x${string}`, limit = 50): StoredSignal[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM signals WHERE token = ? ORDER BY taken_at DESC LIMIT ?`)
    .all(token.toLowerCase(), limit) as any[];
  return rows.map(rowToSignal);
}

/** Every signal for a token within a time window — Meme Radar's input.
 *  Unlike getSignalsForToken, this is bounded by recency, not row count:
 *  a token with heavy history doesn't drown out what actually happened
 *  in the last `sinceTimestamp..now` window. */
export function getSignalsForTokenSince(token: `0x${string}`, sinceTimestamp: number): StoredSignal[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM signals WHERE token = ? AND taken_at >= ? ORDER BY taken_at DESC`)
    .all(token.toLowerCase(), sinceTimestamp) as any[];
  return rows.map(rowToSignal);
}

/** Every distinct token with at least one signal since `sinceTimestamp` —
 *  Meme Radar's candidate list. A token with zero recent signals never
 *  appears here, which is deliberate: Radar ranks what's moving, not
 *  every token FLETCH has ever seen. */
export function getDistinctTokensWithRecentSignals(sinceTimestamp: number): string[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT DISTINCT token FROM signals WHERE taken_at >= ?`)
    .all(sinceTimestamp) as { token: string }[];
  return rows.map((r) => r.token);
}

/** Deletes signals older than `cutoffTimestamp` across every token — the
 *  bounded-storage side of SIGNAL_RETENTION_DAYS. Returns rows removed. */
export function pruneSignalsOlderThan(cutoffTimestamp: number): number {
  const db = getDb();
  const result = db.prepare(`DELETE FROM signals WHERE taken_at < ?`).run(cutoffTimestamp);
  return Number(result.changes);
}

/** How many signals (across every token) fired at or after
 *  `sinceTimestamp` — feeds GET /api/monitoring's "recent activity" view. */
export function countSignalsSince(sinceTimestamp: number): number {
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) as n FROM signals WHERE taken_at >= ?`).get(sinceTimestamp) as { n: number };
  return row.n;
}

function rowToSignal(row: any): StoredSignal {
  return {
    token: row.token,
    type: row.type,
    severity: row.severity,
    confidence: row.confidence,
    evidence: row.evidence,
    explanation: row.explanation,
    blockNumber: row.block_number ?? undefined,
    timestamp: row.taken_at,
  };
}
