import { getDb } from "./db.js";

/**
 * Deployer profiles: every Pons V2 launch FLETCH has registered from one
 * address, and what became of each one.
 *
 * Source of truth is FLETCH's own launch registry (launch_records, filled
 * by discovery in chain/hunt.ts and on-demand lookups in chain/launch.ts),
 * joined with monitoring state and the latest stored report. No chain read.
 *
 * Honest by construction:
 *  - it only covers launches FLETCH has registered, which the response says
 *    (`coverage`) — a deployer can have older launches FLETCH never saw;
 *  - a launch FLETCH hasn't checked yet is UNCHECKED, never counted as
 *    alive or dead;
 *  - rates are computed over checked launches only, and are null when
 *    there are none.
 */

export type LaunchOutcome = "GRADUATED" | "DEAD" | "LIVE" | "UNCHECKED";

export interface DeployerLaunch {
  token: string;
  symbol: string | null;
  name: string | null;
  launchBlock: number;
  launchTxHash: string | null;
  outcome: LaunchOutcome;
  score: number | null;
  riskLevel: string | null;
}

export interface DeployerProfile {
  deployer: string;
  summary: {
    launches: number;
    graduated: number;
    dead: number;
    live: number;
    unchecked: number;
    /** Share of checked launches that are DEAD, 0–100; null if none checked. */
    deadRatePct: number | null;
    /** Share of checked launches that GRADUATED, 0–100; null if none checked. */
    graduatedRatePct: number | null;
    /** Mean latest FLETCH Score over launches that have one; null if none do. */
    avgScore: number | null;
    firstLaunchBlock: number | null;
    lastLaunchBlock: number | null;
  };
  /** Newest first, capped at `limit`. */
  launches: DeployerLaunch[];
  truncated: boolean;
  coverage: string;
}

const COVERAGE =
  "Launches from this address that FLETCH has registered on Pons V2. Older launches FLETCH never scanned are not included.";

type Row = {
  token: string;
  launch_block: number;
  tx: string | null;
  phase: string | null;
  symbol: string | null;
  name: string | null;
  score: number | null;
  risk: string | null;
  status: string | null;
  graduated: number | null;
  has_report: number;
};

export function outcomeOf(r: Pick<Row, "phase" | "status" | "graduated" | "has_report">): LaunchOutcome {
  if (r.phase === "GRADUATED" || r.graduated === 1) return "GRADUATED";
  if (r.phase === "DEAD" || r.status === "DEAD") return "DEAD";
  if (r.phase === "CURVE" || r.has_report === 1) return "LIVE";
  return "UNCHECKED";
}

function pct(n: number, d: number): number | null {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : null;
}

export function getDeployerProfile(deployer: string, limit = 100): DeployerProfile {
  const cap = Math.max(1, Math.min(500, Math.floor(limit)));
  const rows = getDb()
    .prepare(
      `SELECT l.token,
              l.launch_block,
              json_extract(l.record_json, '$.launchTxHash')        AS tx,
              m.phase,
              json_extract(r.report_json, '$.token.symbol')        AS symbol,
              json_extract(r.report_json, '$.token.name')          AS name,
              json_extract(r.report_json, '$.fletchScore.overall') AS score,
              json_extract(r.report_json, '$.risk.level')          AS risk,
              json_extract(r.report_json, '$.status')              AS status,
              json_extract(r.report_json, '$.metrics.graduated')   AS graduated,
              (r.token IS NOT NULL)                                AS has_report
         FROM launch_records l
         LEFT JOIN monitored_tokens m ON m.token = l.token
         LEFT JOIN token_reports r    ON r.token = l.token
        WHERE lower(json_extract(l.record_json, '$.deployer')) = ?
        ORDER BY l.launch_block DESC`
    )
    .all(deployer.toLowerCase()) as Row[];

  const all: DeployerLaunch[] = rows.map((r) => ({
    token: r.token,
    symbol: r.symbol,
    name: r.name,
    launchBlock: r.launch_block,
    launchTxHash: r.tx,
    outcome: outcomeOf(r),
    score: typeof r.score === "number" ? r.score : null,
    riskLevel: r.risk,
  }));

  const count = (o: LaunchOutcome) => all.filter((l) => l.outcome === o).length;
  const graduated = count("GRADUATED");
  const dead = count("DEAD");
  const live = count("LIVE");
  const unchecked = count("UNCHECKED");
  const checked = graduated + dead + live;
  const scored = all.filter((l) => l.score !== null);

  return {
    deployer: deployer.toLowerCase(),
    summary: {
      launches: all.length,
      graduated,
      dead,
      live,
      unchecked,
      deadRatePct: pct(dead, checked),
      graduatedRatePct: pct(graduated, checked),
      avgScore: scored.length ? Math.round(scored.reduce((s, l) => s + (l.score as number), 0) / scored.length) : null,
      firstLaunchBlock: all.length ? all[all.length - 1].launchBlock : null,
      lastLaunchBlock: all.length ? all[0].launchBlock : null,
    },
    launches: all.slice(0, cap),
    truncated: all.length > cap,
    coverage: COVERAGE,
  };
}

/** Who launched this token, and how many launches FLETCH has on file from them. Null if the launch isn't registered. */
export function getTokenDeployer(token: string): { address: string; launches: number } | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT lower(json_extract(record_json, '$.deployer')) AS deployer FROM launch_records WHERE token = ?`)
    .get(token.toLowerCase()) as { deployer: string | null } | undefined;
  if (!row?.deployer) return null;
  const n = db
    .prepare(`SELECT COUNT(*) AS n FROM launch_records WHERE lower(json_extract(record_json, '$.deployer')) = ?`)
    .get(row.deployer) as { n: number };
  return { address: row.deployer, launches: n.n };
}
