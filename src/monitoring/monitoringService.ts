import { config } from "../core/config.js";
import { scanRecentLaunches, type DetectedLaunch } from "../chain/hunt.js";
import { RpcChainDataProvider } from "../data/providers/rpcProvider.js";
import { getSmartMoneyForToken } from "../wallets/smartMoney.js";
import { getSocialSignalForToken } from "../social/social.js";
import { buildIntel } from "../intel/tokenIntel.js";
import { isDeadToken } from "./deadToken.js";
import { getLastTradeBlock, getTradeCoverage } from "../persistence/walletTradesStore.js";
import { saveReport } from "../persistence/reportStore.js";
import { readTokenInfo } from "../chain/token.js";
import { getSignalsForToken } from "../persistence/signalsStore.js";
import { pruneSnapshotsOlderThan } from "../persistence/snapshots.js";
import { pruneSignalsOlderThan } from "../persistence/signalsStore.js";
import {
  upsertDiscovered,
  getDueForCheck,
  recordCheckSuccess,
  recordCheckFailure,
  countMonitored,
  rescheduleWithoutPenalty,
  evictOneForNew,
  getMonitoredToken,
  reactivateFailed,
  type MonitoredToken,
  type MonitoringPriority,
  type Phase,
} from "./monitoringStore.js";
import type { TokenMetrics } from "../data/types.js";
import type { SmartMoneyReport } from "../wallets/smartMoney.js";
import type { SocialReport } from "../social/social.js";
import { RpcBackoff, isRpcRateLimitError, rpcBackoff } from "../core/rpcBackoff.js";

export { rpcBackoff };

/**
 * Everything the monitoring cycles need from the outside world, injected
 * so tests can supply deterministic fakes — see monitoringService.test.ts.
 * Production code uses `defaultDeps`, which wraps the real chain provider.
 */
export interface MonitoringDeps {
  scanLaunches: () => Promise<DetectedLaunch[]>;
  getMetrics: (token: `0x${string}`) => Promise<TokenMetrics>;
  /** Optional: symbol/name for the stored report (cached per process). Absent → stored without a symbol. */
  getInfo?: (token: `0x${string}`) => Promise<{ symbol: string | null; name: string | null; contractExists: boolean }>;
  getSmartMoney: (token: `0x${string}`) => Promise<SmartMoneyReport>;
  getSocial: (token: `0x${string}`) => Promise<SocialReport>;
}

const realProvider = new RpcChainDataProvider();

export const defaultDeps: MonitoringDeps = {
  scanLaunches: () => scanRecentLaunches(),
  getMetrics: (t) => realProvider.getTokenMetrics(t),
  getInfo: (t) => readTokenInfo(t),
  getSmartMoney: getSmartMoneyForToken,
  getSocial: getSocialSignalForToken,
};

export interface DiscoveryResult {
  scanned: number;
  discovered: number;
  skippedCapacity: number;
  /** True when the scan didn't run (or was cut short) because RPC reads are paused. */
  paused: boolean;
  /** True when this call is the one that hit the rate limit and started the pause. */
  rateLimitStarted: boolean;
}

/**
 * Bounded, incremental discovery: scans the same recent-launch window the
 * old poller/Tokens-feed already scan (never the whole chain), and adds
 * anything not already in the monitoring queue. Re-discovering an already-
 * known launch is a cheap no-op (see upsertDiscovered) — this can run as
 * often as DISCOVERY_INTERVAL_MS without duplicating work.
 */
export async function runDiscoveryCycle(
  deps: MonitoringDeps = defaultDeps,
  now: number = Math.floor(Date.now() / 1000),
  backoff: RpcBackoff = rpcBackoff
): Promise<DiscoveryResult> {
  if (backoff.isPaused(now)) return { scanned: 0, discovered: 0, skippedCapacity: 0, paused: true, rateLimitStarted: false };
  let launches: DetectedLaunch[];
  try {
    launches = await deps.scanLaunches();
  } catch (e: unknown) {
    if (!isRpcRateLimitError(e)) throw e;
    const started = backoff.recordRateLimit(now, e);
    return { scanned: 0, discovered: 0, skippedCapacity: 0, paused: true, rateLimitStarted: started };
  }
  backoff.recordSuccess();
  let discovered = 0;
  let skippedCapacity = 0;

  for (const launch of launches) {
    if (getMonitoredToken(launch.token)) continue; // already watched — not a capacity skip
    if (countMonitored() >= config.maxMonitoredTokens && !evictOneForNew()) {
      skippedCapacity++;
      continue; // bounded queue — a launch storm can't grow storage/RPC load without limit
    }
    // New launches start HIGH priority — they need real activity to stay
    // there (see computeNextPriority), but they get a fair first look.
    if (upsertDiscovered(launch.token, now, "HIGH", launch)) discovered++;
  }

  return { scanned: launches.length, discovered, skippedCapacity, paused: false, rateLimitStarted: false };
}

export interface MonitoringCycleResult {
  checked: number;
  succeeded: number;
  failed: number;
  maxConcurrencyObserved: number;
  /** Checks cut short by an RPC rate limit — rescheduled, never counted as token failures. */
  rateLimited: number;
  /** Due checks not started because RPC reads were paused — left untouched, still due. */
  skippedPaused: number;
  /** FAILED tokens given a fresh set of retries after their cool-off this cycle. */
  reactivated: number;
  /** True when a rate limit during this cycle started a new pause. */
  rateLimitStarted: boolean;
}

/**
 * Drains the due-for-check batch with bounded concurrency
 * (MAX_CONCURRENT_TOKENS in-flight chain reads at a time, regardless of
 * queue size) and reuses the existing signal engine as the sole source of
 * signal semantics via analyzeAndPersist — nothing here decides what a
 * signal means. A failure never writes a fake snapshot; only the
 * monitoring queue's own failure metadata is touched.
 */
export async function runMonitoringCycle(
  deps: MonitoringDeps = defaultDeps,
  now: number = Math.floor(Date.now() / 1000),
  concurrency: number = config.maxConcurrentTokens,
  batchSize: number = config.maxConcurrentTokens * 4,
  backoff: RpcBackoff = rpcBackoff
): Promise<MonitoringCycleResult> {
  const reactivated = reactivateFailed(now, config.failedReactivateAfterSeconds);
  if (backoff.isPaused(now)) {
    return { checked: 0, succeeded: 0, failed: 0, maxConcurrencyObserved: 0, rateLimited: 0, skippedPaused: 0, reactivated, rateLimitStarted: false };
  }
  const due = getDueForCheck(now, batchSize);
  let succeeded = 0;
  let failed = 0;
  let rateLimited = 0;
  let skippedPaused = 0;
  let rateLimitStarted = false;

  const { maxConcurrencyObserved } = await runWithConcurrencyLimit(due, concurrency, async (item) => {
    // Once any check in this batch hits the provider's limit, don't start more.
    if (backoff.isPaused(now)) {
      skippedPaused++;
      return;
    }
    try {
      const metrics = await deps.getMetrics(item.token as `0x${string}`);
      const [smartMoney, social] = await Promise.all([deps.getSmartMoney(item.token as `0x${string}`), deps.getSocial(item.token as `0x${string}`)]);
      const info = (await deps.getInfo?.(item.token as `0x${string}`).catch(() => null)) ?? { symbol: null, name: null, contractExists: true };
      const dead = isDeadToken({
        metrics,
        lastTradeBlock: getLastTradeBlock(item.token),
        scannedThroughBlock: getTradeCoverage(item.token)?.latestScannedTo ?? null,
        deadLiquidityEth: config.deadLiquidityEth,
        deadAfterBlocks: config.deadAfterBlocks,
      });
      // Same report a token page shows — stored so pages and the feed can be
      // served without re-reading the chain (persistence/reportStore.ts).
      saveReport(item.token, buildIntel(item.token as `0x${string}`, info, item.launch, metrics, smartMoney, social, now, { dead }), now);

      if (dead) {
        // Off the radar and feed; re-checked rarely so a revival is still caught.
        recordCheckSuccess(item.token as `0x${string}`, "DEAD", now, now + config.deadRecheckSeconds, "LOW");
      } else {
        // A revived token (was DEAD, trades again) returns to CURVE even when graduation is unknown.
        const phase: Phase | null =
          metrics.graduated === true ? "GRADUATED" : metrics.graduated === false ? "CURVE" : item.phase === "DEAD" ? "CURVE" : null;
        const priority = computeNextPriority(item, now);
        recordCheckSuccess(item.token as `0x${string}`, phase, now, now + intervalForPriority(priority), priority);
      }
      backoff.recordSuccess();
      succeeded++;
    } catch (e: unknown) {
      if (isRpcRateLimitError(e)) {
        if (backoff.recordRateLimit(now, e)) rateLimitStarted = true;
        rescheduleWithoutPenalty(item.token as `0x${string}`, backoff.resumeAt, now);
        rateLimited++;
        return;
      }
      const message =
        typeof e === "object" && e !== null && "message" in e && typeof (e as { message: unknown }).message === "string"
          ? (e as { message: string }).message
          : String(e);
      recordCheckFailure(item.token as `0x${string}`, message, now, now + config.pollIntervalMs / 1000, config.maxConsecutiveFailures);
      failed++;
    }
  });

  return {
    checked: due.length - skippedPaused,
    succeeded,
    failed,
    maxConcurrencyObserved,
    rateLimited,
    skippedPaused,
    reactivated,
    rateLimitStarted,
  };
}

/**
 * Priority model: NEW LAUNCH and anything with a signal in Radar's own
 * window are HIGH; anything with a signal ever (but not recently) is
 * NORMAL; a token that's never produced a signal and isn't a fresh launch
 * settles to LOW. Reuses the same signals table Radar reads — no second
 * source of truth for "what counts as active."
 */
export function computeNextPriority(item: MonitoredToken, now: number): MonitoringPriority {
  const NEW_LAUNCH_GRACE_SECONDS = 3600; // give every launch a fair first hour at HIGH before demoting a quiet one
  if (now - item.firstDetectedAt < NEW_LAUNCH_GRACE_SECONDS) return "HIGH";

  const recentSignals = getSignalsForToken(item.token as `0x${string}`, 1);
  if (recentSignals.length === 0) return "LOW";

  const RADAR_LIKE_WINDOW_SECONDS = 1800;
  return now - recentSignals[0].timestamp <= RADAR_LIKE_WINDOW_SECONDS ? "HIGH" : "NORMAL";
}

function intervalForPriority(priority: MonitoringPriority): number {
  const baseSeconds = config.pollIntervalMs / 1000;
  if (priority === "HIGH") return baseSeconds;
  if (priority === "NORMAL") return baseSeconds * 3;
  return baseSeconds * 8; // LOW
}

export interface RetentionResult {
  snapshotsRemoved: number;
  signalsRemoved: number;
}

/** Bounded storage: deletes snapshot/signal rows older than the configured
 *  retention window. Cheap enough to run once per discovery cycle rather
 *  than needing its own schedule. */
export function runRetentionCycle(now: number = Math.floor(Date.now() / 1000)): RetentionResult {
  const snapshotsRemoved = pruneSnapshotsOlderThan(now - config.snapshotRetentionDays * 86_400);
  const signalsRemoved = pruneSignalsOlderThan(now - config.signalRetentionDays * 86_400);
  return { snapshotsRemoved, signalsRemoved };
}

/**
 * Runs `worker` over `items` with at most `limit` in flight at once. One
 * item throwing never stops the others — `worker` is expected to catch
 * its own errors (see runMonitoringCycle), so this never rejects. Returns
 * the actual peak concurrency observed, which the stress test uses to
 * verify the bound is real, not just configured.
 */
async function runWithConcurrencyLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<{ maxConcurrencyObserved: number }> {
  let nextIndex = 0;
  let inFlight = 0;
  let maxConcurrencyObserved = 0;

  async function runNext(): Promise<void> {
    const i = nextIndex++;
    if (i >= items.length) return;
    inFlight++;
    maxConcurrencyObserved = Math.max(maxConcurrencyObserved, inFlight);
    try {
      await worker(items[i]);
    } finally {
      inFlight--;
    }
    await runNext();
  }

  const starters = Array.from({ length: Math.min(limit, items.length) }, () => runNext());
  await Promise.all(starters);
  return { maxConcurrencyObserved };
}
