import { getDb } from "./db.js";

/**
 * Header search — answered entirely from what FLETCH has already stored
 * (the permanent launch registry and the latest per-token reports), so a
 * search never costs an RPC call and never waits on the chain.
 *
 * Symbols and names are deployer-chosen text: they are returned as data
 * and must be escaped by whoever renders them (the dashboard does).
 */

export interface SearchHit {
  token: string;
  symbol: string | null;
  name: string | null;
  score: number | null;
  riskLevel: string | null;
  holders: number | null;
  dead: boolean;
  updatedAt: number | null;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_PREFIX = /^0x[0-9a-fA-F]{2,39}$/;

/** Escapes LIKE wildcards so "%" or "_" in a query are matched literally. */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function isKnownToken(address: string): boolean {
  const a = address.toLowerCase();
  const db = getDb();
  return (
    !!db.prepare(`SELECT 1 FROM launch_records WHERE token = ?`).get(a) ||
    !!db.prepare(`SELECT 1 FROM token_reports WHERE token = ?`).get(a)
  );
}

export function searchTokens(query: string, limit = 8): SearchHit[] {
  const q = query.trim().replace(/^\$/, "");
  if (!q) return [];
  const db = getDb();
  const cap = Math.max(1, Math.min(20, limit));

  // Tokens FLETCH has a report for: match symbol, name, or address prefix.
  // Exact symbol matches first, then symbol prefix, then most recently checked.
  const isHex = HEX_PREFIX.test(q) || ADDRESS.test(q);
  const pat = `%${likeEscape(q)}%`;
  const pre = `${likeEscape(q)}%`;
  const cols = `token,
              json_extract(report_json, '$.token.symbol')        AS symbol,
              json_extract(report_json, '$.token.name')          AS name,
              json_extract(report_json, '$.fletchScore.overall') AS score,
              json_extract(report_json, '$.risk.level')          AS riskLevel,
              json_extract(report_json, '$.metrics.holderCount') AS holders,
              json_extract(report_json, '$.status')              AS status,
              taken_at`;
  type Row = {
    token: string; symbol: string | null; name: string | null; score: number | null; riskLevel: string | null;
    holders: number | null; status: string | null; taken_at: number;
  };
  const rows = (
    isHex
      ? db.prepare(`SELECT ${cols} FROM token_reports WHERE token LIKE ? ESCAPE '\\' ORDER BY taken_at DESC LIMIT ?`).all(pre.toLowerCase(), cap)
      : db
          .prepare(
            `SELECT ${cols} FROM token_reports
              WHERE symbol LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\'
              ORDER BY (symbol = ? COLLATE NOCASE) DESC, (symbol LIKE ? ESCAPE '\\') DESC, taken_at DESC
              LIMIT ?`
          )
          .all(pat, pat, q, pre, cap)
  ) as Row[];

  const hits: SearchHit[] = rows.map((r) => ({
    token: r.token,
    symbol: r.symbol,
    name: r.name,
    score: typeof r.score === "number" ? r.score : null,
    riskLevel: r.riskLevel,
    holders: typeof r.holders === "number" ? r.holders : null,
    dead: r.status === "DEAD",
    updatedAt: r.taken_at,
  }));

  // An address FLETCH has registered but not yet reported on still counts.
  if (isHex && hits.length < cap) {
    const seen = new Set(hits.map((h) => h.token));
    const extra = db
      .prepare(`SELECT token FROM launch_records WHERE token LIKE ? ESCAPE '\\' ORDER BY launch_block DESC LIMIT ?`)
      .all(pre.toLowerCase(), cap) as { token: string }[];
    for (const e of extra) {
      if (hits.length >= cap) break;
      if (seen.has(e.token)) continue;
      hits.push({ token: e.token, symbol: null, name: null, score: null, riskLevel: null, holders: null, dead: false, updatedAt: null });
    }
  }
  return hits;
}

export function isFullAddress(q: string): boolean {
  return ADDRESS.test(q.trim());
}
