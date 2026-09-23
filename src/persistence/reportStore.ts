import { getDb } from "./db.js";
import { bigIntSafe } from "../api/jsonSafe.js";

/** A stored report: the exact JSON body of GET /api/tokens/:address, plus when it was computed. */
export interface StoredReport {
  token: string;
  takenAt: number;
  report: Record<string, unknown>;
}

export function saveReport(token: string, report: unknown, now: number = Math.floor(Date.now() / 1000)): void {
  getDb()
    .prepare(`INSERT INTO token_reports (token, report_json, taken_at) VALUES (?, ?, ?)
              ON CONFLICT(token) DO UPDATE SET report_json = excluded.report_json, taken_at = excluded.taken_at`)
    .run(token.toLowerCase(), JSON.stringify(bigIntSafe(report)), now);
}

export function getReport(token: string): StoredReport | null {
  const row = getDb().prepare(`SELECT * FROM token_reports WHERE token = ?`).get(token.toLowerCase()) as
    | { token: string; report_json: string; taken_at: number }
    | undefined;
  return row ? { token: row.token, takenAt: row.taken_at, report: JSON.parse(row.report_json) } : null;
}

/** Most recently computed reports first, only those newer than `sinceTs`. */
export function listReports(sinceTs: number, limit: number): StoredReport[] {
  const rows = getDb()
    .prepare(`SELECT * FROM token_reports WHERE taken_at >= ? ORDER BY taken_at DESC LIMIT ?`)
    .all(sinceTs, limit) as { token: string; report_json: string; taken_at: number }[];
  return rows.map((r) => ({ token: r.token, takenAt: r.taken_at, report: JSON.parse(r.report_json) }));
}
