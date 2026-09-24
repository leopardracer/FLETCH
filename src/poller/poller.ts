import { config } from "../core/config.js";
import { runDiscoveryCycle, runMonitoringCycle, runRetentionCycle, rpcBackoff } from "../monitoring/monitoringService.js";
import { runActivitySweep } from "../monitoring/activitySweep.js";

function logPauseStarted(): void {
  const s = rpcBackoff.state(Math.floor(Date.now() / 1000));
  if (!s.paused || s.resumeAt === null) return;
  console.warn(
    `RPC ${s.lastReason} — pausing all chain reads until ${new Date(s.resumeAt * 1000).toISOString()} ` +
      `(pause #${s.consecutiveRateLimits}). Tokens are not penalized; checks resume automatically.`
  );
}

let monitoringRunning = false;
let discoveryRunning = false;
let sweepRunning = false;

/**
 * The continuous side of FLETCH: without this, snapshots/signals only
 * accumulate when someone happens to open a token page. Two independent
 * intervals:
 *
 *  - discovery (DISCOVERY_INTERVAL_MS): bounded-window launch scan, adds
 *    anything new to the durable monitoring queue (monitoring/monitoringStore.ts).
 *    Also runs the retention prune — cheap enough not to need its own clock.
 *  - monitoring (POLL_INTERVAL_MS): drains whatever's due from that queue,
 *    bounded concurrency (MAX_CONCURRENT_TOKENS), prioritizing new launches
 *    and tokens with recent signals over quiet ones — see
 *    monitoring/monitoringService.ts's computeNextPriority.
 *
 * Both survive process restart because the queue itself is a SQLite table,
 * not in-memory state. Set ENABLE_POLLER=false to disable entirely.
 *
 * Returns a stop function that clears both intervals — see index.ts's
 * SIGTERM/SIGINT handler. Calling it is optional: it exists for a clean
 * shutdown, not for correctness while running.
 */
export function startPoller(): () => void {
  if (!config.enablePoller) {
    console.log("Poller disabled (ENABLE_POLLER=false) — signals/snapshots only accumulate from page views.");
    return () => {};
  }
  console.log(
    `Monitoring enabled: discovery every ${config.discoveryIntervalMs / 1000}s, ` +
      `checks every ${config.pollIntervalMs / 1000}s (max ${config.maxConcurrentTokens} concurrent, ` +
      `${config.maxMonitoredTokens} token cap).`
  );

  const discoveryTick = () =>
    void runDiscoveryTick().catch((e) => console.error("Discovery tick failed:", e?.message ?? e));
  const monitoringTick = () =>
    void runMonitoringTick().catch((e) => console.error("Monitoring tick failed:", e?.message ?? e));
  const sweepTick = () =>
    void runSweepTick().catch((e) => console.error("Activity sweep failed:", e?.message ?? e));

  discoveryTick();
  monitoringTick();
  const discoveryHandle = setInterval(discoveryTick, config.discoveryIntervalMs);
  const monitoringHandle = setInterval(monitoringTick, config.pollIntervalMs);
  // Offset from the discovery+monitoring burst at start-up so the three
  // don't hit the RPC in the same second (found live: a fresh deploy tripped
  // the rate limit within two minutes).
  let sweepHandle: ReturnType<typeof setInterval> | undefined;
  const sweepStart = setTimeout(() => {
    sweepTick();
    sweepHandle = setInterval(sweepTick, config.activitySweepIntervalMs);
  }, Math.min(30_000, config.activitySweepIntervalMs / 2));

  return () => {
    clearInterval(discoveryHandle);
    clearInterval(monitoringHandle);
    clearTimeout(sweepStart);
    if (sweepHandle) clearInterval(sweepHandle);
  };
}

async function runSweepTick(): Promise<void> {
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    const r = await runActivitySweep();
    if (r.rateLimitStarted) logPauseStarted();
    if (r.promoted > 0 || r.demoted > 0) {
      console.log(`Activity sweep: ${r.curvesWatched} curves, ${r.tradesSeen} trade(s) → ${r.promoted} token(s) now HIGH, ${r.demoted} quiet launch(es) → LOW.`);
    }
  } finally {
    sweepRunning = false;
  }
}

async function runDiscoveryTick(): Promise<void> {
  if (discoveryRunning) return; // don't overlap ticks if one run is still in flight
  discoveryRunning = true;
  try {
    const result = await runDiscoveryCycle();
    if (result.rateLimitStarted) logPauseStarted();
    if (result.discovered > 0 || result.skippedCapacity > 0) {
      console.log(`Discovery: scanned ${result.scanned}, added ${result.discovered} new, skipped ${result.skippedCapacity} (queue at capacity).`);
    }
    const retention = runRetentionCycle();
    if (retention.snapshotsRemoved > 0 || retention.signalsRemoved > 0) {
      console.log(`Retention: pruned ${retention.snapshotsRemoved} old snapshot(s), ${retention.signalsRemoved} old signal(s).`);
    }
  } finally {
    discoveryRunning = false;
  }
}

async function runMonitoringTick(): Promise<void> {
  if (monitoringRunning) return;
  monitoringRunning = true;
  try {
    const result = await runMonitoringCycle();
    if (result.rateLimitStarted) logPauseStarted();
    if (result.reactivated > 0) {
      console.log(`Monitoring: reactivated ${result.reactivated} FAILED token(s) after cool-off.`);
    }
    if (result.checked > 0) {
      const limited = result.rateLimited > 0 ? `, ${result.rateLimited} rate-limited (rescheduled, not counted)` : "";
      console.log(`Monitoring: checked ${result.checked} (${result.succeeded} ok, ${result.failed} failed${limited}), peak concurrency ${result.maxConcurrencyObserved}.`);
    }
  } finally {
    monitoringRunning = false;
  }
}
