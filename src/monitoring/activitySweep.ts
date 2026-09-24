import { config } from "../core/config.js";
import { getClient } from "../chain/client.js";
import { curveAbi } from "../chain/pons.js";
import { fetchLogsInChunks } from "../chain/logScan.js";
import { RpcBackoff, isRpcRateLimitError, rpcBackoff } from "../core/rpcBackoff.js";
import { listActiveCurves, markActive, demoteQuietLaunches } from "./monitoringStore.js";

/**
 * The cheap half of monitoring: "which watched tokens are actually being
 * traded right now?"
 *
 * Found live: ~3,300 tokens launch on Robinhood Chain a day and most never
 * trade. Every new launch got a full check (holders, liquidity, trade
 * history, several RPC calls each) the moment it was discovered, at HIGH
 * priority for its first hour — so the whole check budget went to dead
 * launches, the queue filled with never-checked tokens, and the tokens
 * people were actually trading were checked rarely or not at all.
 *
 * The sweep answers the question with a handful of calls for the whole
 * queue: one eth_getLogs for the CurveBuy/CurveSell events of up to 100
 * curves at a time, over just the blocks since the last sweep. Then:
 *  - a token with a new trade → HIGH and due now (markActive);
 *  - a launch watched for QUIET_AFTER_SECONDS with no trade ever → LOW,
 *    before it ever costs a full check (demoteQuietLaunches).
 * A trade in the launch block itself is the deployer's own dev buy, not
 * market activity, and is ignored.
 */

export interface SweepLog {
  address: string;
  blockNumber: bigint | null;
}

export interface SweepDeps {
  latestBlock: () => Promise<bigint>;
  /** Buy+Sell logs for these curve addresses over [from, to]. */
  getLogs: (addresses: `0x${string}`[], fromBlock: bigint, toBlock: bigint) => Promise<SweepLog[]>;
}

export const defaultSweepDeps: SweepDeps = {
  latestBlock: () => getClient().getBlockNumber(),
  getLogs: (addresses, fromBlock, toBlock) =>
    fetchLogsInChunks(
      (r) => getClient().getLogs({ address: addresses, events: [curveAbi[0], curveAbi[1]], fromBlock: r.fromBlock, toBlock: r.toBlock }),
      fromBlock,
      toBlock,
      BigInt(config.logScanChunkBlocks)
    ) as Promise<SweepLog[]>,
};

/** Curves per eth_getLogs call — well inside what providers accept for an address list. */
export const ADDRESSES_PER_CALL = 100;
/** How long a new launch gets to show a first trade before it's demoted to LOW. */
export const QUIET_AFTER_SECONDS = 15 * 60;
/** First sweep after a restart looks back this far (~10 minutes). */
const FIRST_SWEEP_LOOKBACK_BLOCKS = 2_400n;
/** Never sweep more than this in one go, however long the process was paused. */
const MAX_SWEEP_BLOCKS = 20_000n;

let cursor: bigint | null = null;
/** Tests only. */
export function resetSweepCursor(value: bigint | null = null): void {
  cursor = value;
}

export interface SweepResult {
  paused: boolean;
  rateLimitStarted: boolean;
  fromBlock: number | null;
  toBlock: number | null;
  curvesWatched: number;
  tradesSeen: number;
  promoted: number;
  demoted: number;
}

export async function runActivitySweep(
  deps: SweepDeps = defaultSweepDeps,
  now: number = Math.floor(Date.now() / 1000),
  backoff: RpcBackoff = rpcBackoff,
  lowIntervalSeconds: number = (config.pollIntervalMs / 1000) * 8
): Promise<SweepResult> {
  const empty = { fromBlock: null, toBlock: null, curvesWatched: 0, tradesSeen: 0, promoted: 0 };
  if (backoff.isPaused(now)) return { ...empty, paused: true, rateLimitStarted: false, demoted: 0 };

  const curves = listActiveCurves();
  const byCurve = new Map(curves.map((c) => [c.curve, c]));
  let promoted = 0;
  let tradesSeen = 0;
  let from: bigint;
  let to: bigint;

  try {
    const latest = await deps.latestBlock();
    from = cursor === null ? latest - FIRST_SWEEP_LOOKBACK_BLOCKS : cursor + 1n;
    if (latest - from > MAX_SWEEP_BLOCKS) from = latest - MAX_SWEEP_BLOCKS;
    to = latest;

    if (from <= to && curves.length > 0) {
      const lastSeen = new Map<string, number>();
      const addrs = curves.map((c) => c.curve as `0x${string}`);
      for (let i = 0; i < addrs.length; i += ADDRESSES_PER_CALL) {
        const logs = await deps.getLogs(addrs.slice(i, i + ADDRESSES_PER_CALL), from, to);
        for (const l of logs) {
          const c = byCurve.get(l.address.toLowerCase());
          if (!c || l.blockNumber === null) continue;
          const b = Number(l.blockNumber);
          if (c.launchBlock !== null && b <= c.launchBlock) continue; // the dev buy in the launch tx isn't market activity
          tradesSeen++;
          lastSeen.set(c.token, Math.max(lastSeen.get(c.token) ?? 0, b));
        }
      }
      for (const [token, block] of lastSeen) if (markActive(token, block, now)) promoted++;
    }
    cursor = to;
    backoff.recordSuccess();
  } catch (e: unknown) {
    if (!isRpcRateLimitError(e)) throw e;
    const started = backoff.recordRateLimit(now, e);
    // The cursor isn't advanced: the same blocks are swept again after the pause.
    return { ...empty, paused: true, rateLimitStarted: started, demoted: 0 };
  }

  // Only after a successful sweep: a failed read is not evidence of "no trades".
  const demoted = demoteQuietLaunches(now, QUIET_AFTER_SECONDS, lowIntervalSeconds);
  return {
    paused: false,
    rateLimitStarted: false,
    fromBlock: Number(from),
    toBlock: Number(to),
    curvesWatched: curves.length,
    tradesSeen,
    promoted,
    demoted,
  };
}
