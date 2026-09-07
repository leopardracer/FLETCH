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
