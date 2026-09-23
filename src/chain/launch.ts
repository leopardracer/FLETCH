import { getStoredLaunchRecord, saveLaunchRecord } from "../persistence/launchRegistry.js";
import { getClient } from "./client.js";
import { PONS_V2_FACTORY, factoryAbi } from "./pons.js";
import { config } from "../core/config.js";
import { fetchLogsInChunks, boundedScanStart } from "./logScan.js";

export interface LaunchRecord {
  found: true;
  token: `0x${string}`;
  curve: `0x${string}`;
  deployer: `0x${string}`;
  pairToken: `0x${string}`;
  launchConfigId: bigint;
  graduationThreshold: bigint;
  launchBlock: bigint;
  launchTxHash: `0x${string}`;
}

export interface NoLaunchRecord {
  found: false;
  reason: string;
}

/**
 * Looks up a token's TokenLaunched event on the Pons V2 factory — the real
 * source for "who deployed it, and which curve backs it," with no
 * indexer needed (the factory names both as indexed args).
 *
 * Bounded and chunked (see chain/logScan.ts) rather than scanning
 * `sinceBlock` (default: genesis) straight through to latest in one
 * call — confirmed against real Robinhood Chain mainnet as a real
 * failure, not a theoretical one: a from-genesis scan is the single
 * widest possible eth_getLogs range, and gets rejected outright by any
 * RPC provider with a block-range cap (free tiers on both major
 * providers tested cap a single call at 5-10 blocks). Past the cap,
 * `found: false` here means "no launch found within the lookback
 * window" — honestly not the same claim as "definitely not a Pons
 * token," which callers should not read into it.
 */
export async function readLaunchRecord(
  tokenAddress: `0x${string}`,
  sinceBlock: bigint = 0n
): Promise<LaunchRecord | NoLaunchRecord> {
  const stored = getStoredLaunchRecord(tokenAddress);
  if (stored) return stored; // zero RPC — and works however old the token is

  const client = getClient();
  const latest = await client.getBlockNumber();
  const { fromBlock } = boundedScanStart(sinceBlock, latest, true, config.maxHolderScanBlocks);

  const logs = await fetchLogsInChunks(
    (range) =>
      client.getLogs({
        address: PONS_V2_FACTORY,
        event: factoryAbi[0], // TokenLaunched
        args: { token: tokenAddress },
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
      }),
    fromBlock,
    latest,
    config.logScanChunkBlocks
  );

  if (logs.length === 0) {
    return {
      found: false,
      reason:
        "no TokenLaunched event found for this address on the Pons V2 factory " +
        "(could be a non-Pons token, a Pons V1 launch, or launched before the scan's lookback window — see MAX_HOLDER_SCAN_BLOCKS)",
    };
  }

  const log = logs[0];
  const args = log.args as {
    curve: `0x${string}`;
    deployer: `0x${string}`;
    pairToken: `0x${string}`;
    launchConfigId: bigint;
    graduationThreshold: bigint;
  };

  const rec: LaunchRecord = {
    found: true,
    token: tokenAddress,
    curve: args.curve,
    deployer: args.deployer,
    pairToken: args.pairToken,
    launchConfigId: args.launchConfigId,
    graduationThreshold: args.graduationThreshold,
    launchBlock: log.blockNumber!,
    launchTxHash: log.transactionHash!,
  };
  saveLaunchRecord(rec);
  return rec;
}

export interface CurveState {
  /** null = scan was bounded (see MAX_HOLDER_SCAN_BLOCKS) and no
   *  graduation event was found within that window — genuinely unknown,
   *  since the real event could be earlier than the window. Only `false`
   *  when the *full* launch-to-latest range was actually checked. */
  graduated: boolean | null;
  lastPriceInPair: number | null;
  progressPercent: number | null;
}

/**
 * Reads whether a curve has graduated by checking for a CurveCompleted /
 * PoolGraduated event since launch. If not graduated, progress is left null
 * here — computing it precisely needs the curve's own view function, which
 * isn't public/documented, so liquidity.ts derives progress from the curve's
 * quote-asset balance instead of guessing at a formula.
 *
 * Bounded and chunked the same way as readHolderStats/readLaunchRecord
 * (see chain/logScan.ts) — an old token's launch-to-latest range has the
 * exact same real-world failure mode as the holder scan. Finding a
 * graduation event is conclusive regardless of bounding (once graduated,
 * always graduated), but *not* finding one only means "not graduated
 * within the window actually checked" — see the null case above.
 */
/** Pure: given whether a graduation event was found and whether the scan
 *  covering it was complete (unbounded) or capped, decides the honest
 *  graduated value. Extracted purely for direct testability — see
 *  launch.test.ts. */
export function deriveGraduated(eventFound: boolean, scanWasComplete: boolean): boolean | null {
  if (eventFound) return true; // conclusive regardless of bounding — once graduated, always graduated
  return scanWasComplete ? false : null;
}

export async function readCurveState(launch: LaunchRecord): Promise<CurveState> {
  const client = getClient();
  const latest = await client.getBlockNumber();
  const { fromBlock, isComplete } = boundedScanStart(launch.launchBlock, latest, true, config.maxHolderScanBlocks);

  const graduatedLogs = await fetchLogsInChunks(
    (range) =>
      client.getLogs({
        address: PONS_V2_FACTORY,
        event: {
          type: "event",
          name: "PoolGraduated",
          inputs: [
            { name: "token", type: "address", indexed: true },
            { name: "positionId", type: "uint256", indexed: false },
            { name: "tokenAmount", type: "uint256", indexed: false },
            { name: "pairTokenAmount", type: "uint256", indexed: false },
          ],
        },
        args: { token: launch.token },
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
      }),
    fromBlock,
    latest,
    config.logScanChunkBlocks
  );

  const found = graduatedLogs.length > 0;
  return {
    graduated: deriveGraduated(found, isComplete),
    lastPriceInPair: null,
    progressPercent: null,
  };
}
