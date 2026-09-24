import { config } from "./config.js";

/**
 * RPC rate-limit awareness for the continuous poller.
 *
 * Found in live use: once a provider's quota ran out (HTTP 429, then
 * QuickNode's "daily request limit reached"), every monitoring cycle kept
 * firing a full batch of checks every POLL_INTERVAL_MS — 20 guaranteed
 * failures per tick — and each one counted against the token itself, so
 * perfectly healthy tokens walked toward FAILED for a problem that was
 * never theirs.
 *
 * Found live again on Robinhood Chain's free public RPC: under load it
 * answers HTTP 403 Forbidden rather than 429. That was treated as a
 * per-token failure, so nothing paused, every tick kept hitting the
 * endpoint, and it stayed blocked — ~6 successful checks an hour out of
 * a 500-token queue. A 403 from the RPC is now a rate limit too.
 *
 * Two fixes live here:
 *  - isRpcRateLimitError: tells "the provider said slow down / out of
 *    quota" apart from a real per-token failure.
 *  - RpcBackoff: a circuit breaker. A rate-limit error pauses chain reads
 *    for an exponentially growing window (RPC_BACKOFF_BASE_MS doubling up
 *    to RPC_BACKOFF_MAX_MS); a daily-quota error jumps straight to the
 *    maximum, since retrying in a minute can't help. Any successful chain
 *    read resets it.
 */

const RATE_LIMIT_PATTERNS = [
  /too many requests/i,
  /rate[\s-]?limit/i,
  /request limit reached/i,
  /exceeded .*(limit|quota|capacity)/i,
  /quota (exceeded|exhausted)/i,
  /\b429\b/,
];
const DAILY_QUOTA_PATTERNS = [/daily request limit/i, /daily (quota|limit)/i, /upgrade your (account|plan)/i];

/** Walks an error and its `cause` chain (viem nests the HTTP error) collecting status codes and text. */
function collect(e: unknown): { statuses: number[]; text: string } {
  const statuses: number[] = [];
  const parts: string[] = [];
  let current: unknown = e;
  for (let depth = 0; current && depth < 8; depth++) {
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (typeof current !== "object") break;
    const obj = current as Record<string, unknown>;
    if (typeof obj.status === "number") statuses.push(obj.status);
    for (const key of ["message", "shortMessage", "details"]) {
      if (typeof obj[key] === "string") parts.push(obj[key] as string);
    }
    current = obj.cause;
  }
  return { statuses, text: parts.join(" \n ") };
}

export function isRpcRateLimitError(e: unknown): boolean {
  const { statuses, text } = collect(e);
  // 403: the public RPC's way of saying "too much from you" (see header).
  if (statuses.includes(429) || statuses.includes(403)) return true;
  if (/\bStatus:\s*(429|403)\b/.test(text)) return true;
  return RATE_LIMIT_PATTERNS.some((p) => p.test(text)) || DAILY_QUOTA_PATTERNS.some((p) => p.test(text));
}

export function isDailyQuotaError(e: unknown): boolean {
  const { text } = collect(e);
  return DAILY_QUOTA_PATTERNS.some((p) => p.test(text));
}

export interface RpcBackoffState {
  paused: boolean;
  /** Unix seconds when chain reads resume; null when not paused. */
  resumeAt: number | null;
  consecutiveRateLimits: number;
  lastReason: string | null;
}

export class RpcBackoff {
  private resumeAtSec = 0;
  private consecutive = 0;
  private reason: string | null = null;

  constructor(
    private readonly baseSeconds: number,
    private readonly maxSeconds: number
  ) {}

  isPaused(nowSec: number): boolean {
    return nowSec < this.resumeAtSec;
  }

  get resumeAt(): number {
    return this.resumeAtSec;
  }

  /**
   * Opens (or extends) the pause after a rate-limit error. Returns true only
   * when this call started a new pause — so the caller logs once per pause,
   * not once per failed request.
   */
  recordRateLimit(nowSec: number, error: unknown): boolean {
    if (this.isPaused(nowSec)) return false; // several in-flight requests hitting the same limit = one event
    this.consecutive++;
    const daily = isDailyQuotaError(error);
    const window = daily ? this.maxSeconds : Math.min(this.maxSeconds, this.baseSeconds * 2 ** (this.consecutive - 1));
    this.resumeAtSec = nowSec + window;
    this.reason = daily ? "provider daily request quota reached" : "provider rate limit (HTTP 429)";
    return true;
  }

  recordSuccess(): void {
    this.consecutive = 0;
    this.resumeAtSec = 0;
    this.reason = null;
  }

  state(nowSec: number): RpcBackoffState {
    const paused = this.isPaused(nowSec);
    return {
      paused,
      resumeAt: paused ? this.resumeAtSec : null,
      consecutiveRateLimits: this.consecutive,
      lastReason: this.reason,
    };
  }
}

/** The process-wide circuit breaker shared by the poller (monitoring/
 *  monitoringService.ts) and GET /api/health. */
export const rpcBackoff = new RpcBackoff(config.rpcBackoffBaseMs / 1000, config.rpcBackoffMaxMs / 1000);
