import { config } from "../core/config.js";
import { runDiscoveryCycle, runMonitoringCycle, runRetentionCycle } from "../monitoring/monitoringService.js";

let monitoringRunning = false;
let discoveryRunning = false;

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

  discoveryTick();
  monitoringTick();
  const discoveryHandle = setInterval(discoveryTick, config.discoveryIntervalMs);
  const monitoringHandle = setInterval(monitoringTick, config.pollIntervalMs);

  return () => {
    clearInterval(discoveryHandle);
    clearInterval(monitoringHandle);
  };
}

async function runDiscoveryTick(): Promise<void> {
  if (discoveryRunning) return; // don't overlap ticks if one run is still in flight
  discoveryRunning = true;
  try {
    const result = await runDiscoveryCycle();
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
    if (result.checked > 0) {
      console.log(`Monitoring: checked ${result.checked} (${result.succeeded} ok, ${result.failed} failed), peak concurrency ${result.maxConcurrencyObserved}.`);
    }
  } finally {
    monitoringRunning = false;
  }
}
