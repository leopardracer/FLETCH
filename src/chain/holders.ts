import { formatUnits } from "viem";
import { getClient } from "./client.js";
import { erc20Abi } from "./token.js";
import { readLaunchRecord } from "./launch.js";
import { PONS_PROTOCOL_ADDRESSES } from "./pons.js";
import { config } from "../core/config.js";

export interface HolderStats {
  windowFromBlock: bigint;
  windowToBlock: bigint;
  /** True lifetime count when a Pons V2 launch record exists for this token
   *  (scan starts at the real launch block); false only falls back to a
   *  block-window scan for non-Pons tokens. */
  isLifetime: boolean;
  holderCount: number;
  topAccumulators: { address: string; netChange: number }[];
  whaleMoves: { from: string; to: string; amount: number; txHash: string; blockNumber: string }[];
}

const PROTOCOL_SET = new Set(PONS_PROTOCOL_ADDRESSES.map((a) => a.toLowerCase()));

export interface LogRange {
  fromBlock: bigint;
  toBlock: bigint;
}

/**
 * Splits [fromBlock, toBlock] into chunks of at most `chunkSize` blocks
 * and fetches each sequentially, concatenating the results. Sequential,
 * not parallel — deliberately doesn't add more concurrent load on an
 * already rate-limited RPC (same principle as chain/hunt.ts's per-launch
 * enrichment). Throws on the first chunk that fails, rather than
 * returning whatever succeeded: a holder count computed from partial
 * Transfer history would be genuinely *wrong*, not just less precise —
 * unlike a missing dev-buy check, there's no honest "null" version of a
 * holder count derived from an incomplete log set, so this never
 * silently returns one.
 *
 * `getLogs` is injected purely for testability — no live RPC needed to
 * verify the chunking math or the fail-fast behavior. readHolderStats
 * (below) passes the real client call.
 */
export async function fetchLogsInChunks<T>(
  getLogs: (range: LogRange) => Promise<T[]>,
  fromBlock: bigint,
  toBlock: bigint,
  chunkSize: bigint
): Promise<T[]> {
  if (chunkSize <= 0n) throw new Error("chunkSize must be a positive number of blocks");
  if (fromBlock > toBlock) return [];

  const results: T[] = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = start + chunkSize - 1n > toBlock ? toBlock : start + chunkSize - 1n;
    const chunkLogs = await getLogs({ fromBlock: start, toBlock: end });
    results.push(...chunkLogs);
    start = end + 1n;
  }
  return results;
}

/**
 * Caps how far back a holder scan will ever look, even for an old token
 * whose real launch block is much further back. Confirmed against real
 * Robinhood Chain mainnet: a single eth_getLogs call spanning ~237,000
 * blocks (an old token's full history) was rejected by the public RPC —
 * and chunking that same range would mean well over a hundred sequential
 * requests for one token, which trades one rejected call for a very
 * plausible rate-limit trip instead. Capping the *lookback* bounds the
 * number of chunks directly, regardless of how old the token is.
 *
 * Returns the (possibly capped) fromBlock and whether the result is
 * still a true lifetime count — false the moment the cap actually binds,
 * so callers never call a capped, partial-history count "lifetime."
 */
export function boundedScanStart(
  trueFromBlock: bigint,
  latestBlock: bigint,
  isLifetimeCandidate: boolean,
  maxScanBlocks: bigint
): { fromBlock: bigint; isLifetime: boolean } {
  const span = latestBlock - trueFromBlock;
  if (span <= maxScanBlocks) return { fromBlock: trueFromBlock, isLifetime: isLifetimeCandidate };
  const cappedFromBlock = latestBlock - maxScanBlocks;
  return { fromBlock: cappedFromBlock < 0n ? 0n : cappedFromBlock, isLifetime: false };
}

/**
 * Holder stats for any token, computed via Transfer log replay from the
 * launch block — chunked (LOG_SCAN_CHUNK_BLOCKS per request) and bounded
 * (MAX_HOLDER_SCAN_BLOCKS lookback) so this stays viable against a real,
 * rate-limited RPC even for an old token — see fetchLogsInChunks and
 * boundedScanStart above. This is a real, exact count when isLifetime is
 * true; past the lookback cap, it's an honest bounded-window count
 * instead, never silently presented as lifetime. Still O(transfers) in
 * total RPC log volume per token, which is fine for one token on demand
 * and does not scale to "compute holder counts for every live token
 * continuously." See data/providers/blockscoutProvider.ts for the
 * scalable path.
 */
export async function readHolderStats(
  tokenAddress: `0x${string}`,
  decimals: number,
  whaleThresholdTokens = config.whaleThresholdTokens,
  top = 10
): Promise<HolderStats> {
  const client = getClient();
  const latest = await client.getBlockNumber();

  const launch = await readLaunchRecord(tokenAddress);
  const trueFromBlock = launch.found
    ? launch.launchBlock
    : latest > config.signalWindowBlocks
    ? latest - config.signalWindowBlocks
    : 0n;
  const { fromBlock, isLifetime } = boundedScanStart(trueFromBlock, latest, launch.found, config.maxHolderScanBlocks);

  const logs = await fetchLogsInChunks(
    (range) =>
      client.getLogs({
        address: tokenAddress,
        event: erc20Abi[0], // Transfer
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
      }),
    fromBlock,
    latest,
    config.logScanChunkBlocks
  );

  const balance = new Map<string, bigint>();
  const netChange = new Map<string, bigint>();
  const whaleMoves: HolderStats["whaleMoves"] = [];
  const threshold = BigInt(Math.floor(whaleThresholdTokens)) * 10n ** BigInt(decimals);

  for (const log of logs) {
    const { from, to, value } = log.args as { from: string; to: string; value: bigint };
    balance.set(from, (balance.get(from) ?? 0n) - value);
    balance.set(to, (balance.get(to) ?? 0n) + value);
    netChange.set(from, (netChange.get(from) ?? 0n) - value);
    netChange.set(to, (netChange.get(to) ?? 0n) + value);

    if (value >= threshold) {
      whaleMoves.push({
        from,
        to,
        amount: Number(formatUnits(value, decimals)),
        txHash: log.transactionHash!,
        blockNumber: log.blockNumber!.toString(),
      });
    }
  }

  let holderCount = 0;
  for (const [address, bal] of balance) {
    if (bal > 0n && !PROTOCOL_SET.has(address.toLowerCase())) holderCount++;
  }

  const topAccumulators = [...netChange.entries()]
    .filter(([address]) => !PROTOCOL_SET.has(address.toLowerCase()))
    .sort((a, b) => (b[1] > a[1] ? 1 : -1))
    .slice(0, top)
    .map(([address, change]) => ({ address, netChange: Number(formatUnits(change, decimals)) }));

  return { windowFromBlock: fromBlock, windowToBlock: latest, isLifetime, holderCount, topAccumulators, whaleMoves };
}

/** Concentration of the top N accumulators as a % of total positive balance seen — used by risk analysis. */
export function topHolderConcentrationPercent(stats: HolderStats, topN: number): number | null {
  const positiveTotal = stats.topAccumulators.filter((h) => h.netChange > 0).reduce((s, h) => s + h.netChange, 0);
  if (positiveTotal <= 0) return null;
  const topSum = stats.topAccumulators
    .filter((h) => h.netChange > 0)
    .slice(0, topN)
    .reduce((s, h) => s + h.netChange, 0);
  return (topSum / positiveTotal) * 100;
}
