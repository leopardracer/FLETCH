import { config } from "../core/config.js";
import { scanRecentLaunches } from "../chain/hunt.js";
import { RpcChainDataProvider } from "../data/providers/rpcProvider.js";
import { getSmartMoneyForToken } from "../wallets/smartMoney.js";
import { getSocialSignalForToken } from "../social/social.js";
import { analyzeAndPersist } from "../signals/signalService.js";

const provider = new RpcChainDataProvider();
let running = false;

/**
 * The "real-time" half of the signal engine: without this, snapshots and
 * trend signals only accumulate when someone happens to open a token page.
 * This snapshots the most recently launched tokens on an interval, so
 * holder-growth rate, liquidity change, and activity-acceleration signals
 * exist even with nobody watching.
 *
 * Deliberately conservative by default (5 min, top 15 tokens) — this runs
 * against whatever RPC_URL is configured, which may be the shared public
 * endpoint; see docs/DATA.md on why that's rate-limited. Tune
 * POLL_INTERVAL_MS / POLL_TOKEN_LIMIT for a dedicated RPC provider, and
 * set ENABLE_POLLER=false to disable entirely.
 */
export function startPoller(): void {
  if (!config.enablePoller) {
    console.log("Poller disabled (ENABLE_POLLER=false) — signals/snapshots only accumulate from page views.");
    return;
  }
  console.log(`Poller enabled: snapshotting up to ${config.pollTokenLimit} recent tokens every ${config.pollIntervalMs / 1000}s.`);
  const tick = () => void runOnce().catch((e) => console.error("Poller tick failed:", e?.message ?? e));
  tick(); // run once immediately, then on the interval
  setInterval(tick, config.pollIntervalMs);
}

async function runOnce(): Promise<void> {
  if (running) return; // don't overlap ticks if one run is still in flight
  running = true;
  try {
    const launches = await scanRecentLaunches();
    const targets = launches.slice(0, config.pollTokenLimit);
    for (const launch of targets) {
      try {
        const metrics = await provider.getTokenMetrics(launch.token);
        const smartMoney = await getSmartMoneyForToken(launch.token);
        const social = await getSocialSignalForToken(launch.token);
        analyzeAndPersist(launch.token, launch, metrics, smartMoney, social);
      } catch (e: any) {
        console.warn(`Poller: skipped ${launch.token} — ${e?.message ?? e}`);
      }
    }
  } finally {
    running = false;
  }
}
