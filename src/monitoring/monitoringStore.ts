import { getDb } from "../persistence/db.js";
import type { DetectedLaunch } from "../chain/hunt.js";

export type MonitoringStatus = "ACTIVE" | "PAUSED" | "FAILED" | "COMPLETED";
export type MonitoringPriority = "HIGH" | "NORMAL" | "LOW";
export type Phase = "CURVE" | "GRADUATED" | "DEAD";

export interface MonitoredToken {
  token: string;
  firstDetectedAt: number;
  lastCheckedAt: number | null;
  lastSuccessAt: number | null;
  nextCheckAt: number;
  status: MonitoringStatus;
  phase: Phase | null;
  failureCount: number;
  lastError: string | null;
  priority: MonitoringPriority;
  updatedAt: number;
  /** The launch-moment facts captured once at discovery (curve address,
   *  dev-buy data, etc.) — never re-derived from raw chain logs on every
   *  later check. Null if this token was added to the queue without one
   *  (shouldn't normally happen, but handled honestly rather than assumed). */
  launch: DetectedLaunch | null;
}

/** DetectedLaunch has two bigint fields, which JSON can't represent natively. */
function serializeLaunch(launch: DetectedLaunch): string {
  return JSON.stringify({
    ...launch,
    launchBlock: launch.launchBlock.toString(),
    graduationThreshold: launch.graduationThreshold.toString(),
  });
}

function deserializeLaunch(json: string | null): DetectedLaunch | null {
  if (!json) return null;
  try {
    const obj = JSON.parse(json);
    return { ...obj, launchBlock: BigInt(obj.launchBlock), graduationThreshold: BigInt(obj.graduationThreshold) };
  } catch {
    return null; // corrupt/unreadable cache never crashes a check — just re-derived as null
  }
}

/**
 * The durable monitoring queue — which tokens FLETCH is watching, and
 * enough state per token to schedule the next check without re-deriving
 * anything from a fresh chain scan. Survives process restart because it's
 * a plain SQLite table (see persistence/db.ts). One row per token,
 * `token` is the primary key, so re-discovering an already-known launch
 * is naturally a no-op — see upsertDiscovered.
 */

/** Adds a newly discovered token to the queue if it isn't already there.
 *  Returns true if this actually inserted a new row (a genuinely new
 *  discovery), false if the token was already known — callers use this
 *  to decide whether to log/count it as a new find. Never overwrites an
 *  existing token's monitoring state (status, failure count, etc.) just
 *  because the same launch was seen again in a later discovery scan. */
export function upsertDiscovered(
  token: `0x${string}`,
  now: number,
  priority: MonitoringPriority = "HIGH",
  launch: DetectedLaunch | null = null
): boolean {
  const db = getDb();
  const existing = db.prepare(`SELECT token FROM monitored_tokens WHERE token = ?`).get(token.toLowerCase());
  if (existing) return false;

  db.prepare(
    `INSERT INTO monitored_tokens
      (token, first_detected_at, last_checked_at, last_success_at, next_check_at, status, phase, failure_count, last_error, priority, updated_at, launch_json)
     VALUES (?, ?, NULL, NULL, ?, 'ACTIVE', NULL, 0, NULL, ?, ?, ?)`
  ).run(token.toLowerCase(), now, now, priority, now, launch ? serializeLaunch(launch) : null); // next_check_at = now: a fresh discovery is due immediately
  return true;
}

/** Tokens due for a check right now, most urgent first (priority, then
 *  however overdue they are). Only ACTIVE tokens are ever returned —
 *  FAILED/PAUSED/COMPLETED tokens are never scheduled until something
 *  explicitly reactivates them. */
/** Raw shape of a `monitored_tokens` row as `node:sqlite` returns it —
 *  same reasoning as SnapshotRow/SignalRow in persistence/. */
interface MonitoredTokenRow {
  token: string;
  first_detected_at: number;
  last_checked_at: number | null;
  last_success_at: number | null;
  next_check_at: number;
  status: MonitoringStatus;
  phase: Phase | null;
  failure_count: number;
  last_error: string | null;
  priority: MonitoringPriority;
  updated_at: number;
  launch_json: string | null;
}

export function getDueForCheck(now: number, limit: number): MonitoredToken[] {
  const db = getDb();
  const priorityRank = `CASE priority WHEN 'HIGH' THEN 0 WHEN 'NORMAL' THEN 1 ELSE 2 END`;
  const rows = db
    .prepare(
      `SELECT * FROM monitored_tokens WHERE status = 'ACTIVE' AND next_check_at <= ?
       ORDER BY ${priorityRank} ASC, next_check_at ASC LIMIT ?`
    )
    .all(now, limit) as unknown as MonitoredTokenRow[];
  return rows.map(rowToMonitoredToken);
}

/** Records a successful check: resets the failure count (a working token
 *  should never carry a "grudge" from an old transient RPC blip),
 *  updates phase if known, and schedules the next check. */
export function recordCheckSuccess(token: `0x${string}`, phase: Phase | null, now: number, nextCheckAt: number, priority?: MonitoringPriority): void {
  const db = getDb();
  db.prepare(
    `UPDATE monitored_tokens
     SET last_checked_at = ?, last_success_at = ?, next_check_at = ?, failure_count = 0, last_error = NULL,
         phase = COALESCE(?, phase), priority = COALESCE(?, priority), updated_at = ?
     WHERE token = ?`
  ).run(now, now, nextCheckAt, phase, priority ?? null, now, token.toLowerCase());
}

/** Records a failed check without touching any real metric — never a
 *  fake snapshot. Past `maxConsecutiveFailures`, the token is marked
 *  FAILED and stops being scheduled at all: one permanently-broken
 *  address (a bad contract, a token that self-destructed, whatever)
 *  must not retry forever and waste RPC calls on every cycle. */
export function recordCheckFailure(
  token: `0x${string}`,
  error: string,
  now: number,
  nextCheckAt: number,
  maxConsecutiveFailures: number
): void {
  const db = getDb();
  const row = db.prepare(`SELECT failure_count FROM monitored_tokens WHERE token = ?`).get(token.toLowerCase()) as
    | { failure_count: number }
    | undefined;
  const failureCount = (row?.failure_count ?? 0) + 1;
  const status: MonitoringStatus = failureCount >= maxConsecutiveFailures ? "FAILED" : "ACTIVE";
  db.prepare(
    `UPDATE monitored_tokens
     SET last_checked_at = ?, failure_count = ?, last_error = ?, next_check_at = ?, status = ?, updated_at = ?
     WHERE token = ?`
  ).run(now, failureCount, error, nextCheckAt, status, now, token.toLowerCase());
}

/**
 * Reschedules a token whose check was cut short by an RPC rate limit —
 * the provider's problem, not the token's. Touches only next_check_at:
 * no failure count, no last_error, no status change.
 */
export function rescheduleWithoutPenalty(token: `0x${string}`, nextCheckAt: number, now: number): void {
  const db = getDb();
  db.prepare(`UPDATE monitored_tokens SET next_check_at = ?, updated_at = ? WHERE token = ?`).run(nextCheckAt, now, token.toLowerCase());
}

/**
 * Gives FAILED tokens a fresh set of retries once they've sat out
 * `coolOffSeconds` since their last check — so a stretch of real failures
 * (an RPC outage, say) doesn't leave tokens dead until a process restart.
 * Still bounded: a genuinely broken token burns at most
 * MAX_CONSECUTIVE_FAILURES checks per cool-off window. Returns how many
 * tokens were reactivated. coolOffSeconds <= 0 disables it.
 */
export function reactivateFailed(now: number, coolOffSeconds: number): number {
  if (coolOffSeconds <= 0) return 0;
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE monitored_tokens
       SET status = 'ACTIVE', failure_count = 0, next_check_at = ?, updated_at = ?
       WHERE status = 'FAILED' AND last_checked_at <= ?`
    )
    .run(now, now, now - coolOffSeconds);
  return Number(result.changes);
}

/** Explicitly bumps (or lowers) a token's priority — e.g. when it starts
 *  producing signals and should be checked more often. Does not touch
 *  scheduling directly; the next successful/failed check picks up the
 *  new priority's interval. */
export function setPriority(token: `0x${string}`, priority: MonitoringPriority, now: number): void {
  const db = getDb();
  db.prepare(`UPDATE monitored_tokens SET priority = ?, updated_at = ? WHERE token = ?`).run(priority, now, token.toLowerCase());
}

export function getMonitoredToken(token: `0x${string}`): MonitoredToken | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM monitored_tokens WHERE token = ?`).get(token.toLowerCase()) as MonitoredTokenRow | undefined;
  return row ? rowToMonitoredToken(row) : null;
}

export function countMonitored(status?: MonitoringStatus): number {
  const db = getDb();
  const row = status
    ? (db.prepare(`SELECT COUNT(*) as n FROM monitored_tokens WHERE status = ?`).get(status) as { n: number })
    : (db.prepare(`SELECT COUNT(*) as n FROM monitored_tokens`).get() as { n: number });
  return row.n;
}

export interface MonitoringHealth {
  totalMonitored: number;
  activeCount: number;
  pausedCount: number;
  failedCount: number;
  completedCount: number;
  /** Launches judged dead (drained curve, no trades for a while) — off the radar, re-checked rarely. */
  deadCount: number;
  dueNowCount: number;
  lastSuccessfulCheckAt: number | null;
  nextScheduledCheckAt: number | null;
}

/** Powers GET /api/monitoring — see api/server.ts. */
export function getMonitoringHealth(now: number): MonitoringHealth {
  const db = getDb();
  const counts = db.prepare(`SELECT status, COUNT(*) as n FROM monitored_tokens GROUP BY status`).all() as { status: MonitoringStatus; n: number }[];
  const byStatus: Record<string, number> = {};
  for (const c of counts) byStatus[c.status] = c.n;
  const dueNow = db.prepare(`SELECT COUNT(*) as n FROM monitored_tokens WHERE status = 'ACTIVE' AND next_check_at <= ?`).get(now) as { n: number };
  const lastSuccess = db.prepare(`SELECT MAX(last_success_at) as t FROM monitored_tokens`).get() as { t: number | null };
  const dead = db.prepare(`SELECT COUNT(*) as n FROM monitored_tokens WHERE phase = 'DEAD'`).get() as { n: number };
  const nextScheduled = db
    .prepare(`SELECT MIN(next_check_at) as t FROM monitored_tokens WHERE status = 'ACTIVE'`)
    .get() as { t: number | null };

  return {
    totalMonitored: Object.values(byStatus).reduce((s, n) => s + n, 0),
    activeCount: byStatus.ACTIVE ?? 0,
    pausedCount: byStatus.PAUSED ?? 0,
    failedCount: byStatus.FAILED ?? 0,
    completedCount: byStatus.COMPLETED ?? 0,
    deadCount: dead.n,
    dueNowCount: dueNow.n,
    lastSuccessfulCheckAt: lastSuccess.t ?? null,
    nextScheduledCheckAt: nextScheduled.t ?? null,
  };
}

function rowToMonitoredToken(row: MonitoredTokenRow): MonitoredToken {
  return {
    token: row.token,
    firstDetectedAt: row.first_detected_at,
    lastCheckedAt: row.last_checked_at,
    lastSuccessAt: row.last_success_at,
    nextCheckAt: row.next_check_at,
    status: row.status,
    phase: row.phase,
    failureCount: row.failure_count,
    lastError: row.last_error,
    priority: row.priority,
    updatedAt: row.updated_at,
    launch: deserializeLaunch(row.launch_json ?? null),
  };
}

/**
 * Frees ONE slot in a full queue for a new launch. Found live: at the 500
 * cap every fresh launch was skipped while dead tokens kept their slots.
 * Only ever evicts tokens that have stopped earning attention — FAILED
 * first, then COMPLETED, then LOW priority — least recently useful first.
 * HIGH and NORMAL active tokens are never evicted. Returns false if nothing
 * is evictable (the new launch is then skipped, as before).
 */
export function evictOneForNew(): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT token FROM monitored_tokens
       WHERE status IN ('FAILED','COMPLETED') OR (status = 'ACTIVE' AND priority = 'LOW')
       ORDER BY CASE status WHEN 'FAILED' THEN 0 WHEN 'COMPLETED' THEN 1 ELSE 2 END, COALESCE(last_success_at, 0) ASC
       LIMIT 1`
    )
    .get() as { token: string } | undefined;
  if (!row) return false;
  db.prepare(`DELETE FROM monitored_tokens WHERE token = ?`).run(row.token);
  return true;
}

/** Tokens currently judged dead — excluded from the radar and the feed. */
export function getDeadTokens(): Set<string> {
  const rows = getDb().prepare(`SELECT token FROM monitored_tokens WHERE phase = 'DEAD'`).all() as { token: string }[];
  return new Set(rows.map((r) => r.token));
}
