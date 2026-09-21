/**
 * Shared, bounded log-scanning helpers used by every chain/*.ts function
 * that reads a wide `eth_getLogs` range. Extracted into its own module
 * (rather than living in holders.ts, where the first of these was
 * written) specifically to avoid a circular import: launch.ts needs
 * these too, and holders.ts already imports from launch.ts.
 *
 * Both were added after real Robinhood Chain mainnet testing hit this
 * exact class of failure in more than one place — see holders.test.ts
 * and launch.test.ts for the specific regressions each one fixes.
 */

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
 * returning whatever succeeded: a holder count (or a launch lookup)
 * computed from a partial log set would be genuinely *wrong*, not just
 * less precise, so this never silently returns a partial result.
 *
 * `getLogs` is injected purely for testability — no live RPC needed to
 * verify the chunking math or the fail-fast behavior.
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
 * Caps how far back a log scan will ever look, even when the true start
 * (a token's real launch block, or an explicit `sinceBlock` — including
 * the common default of block 0, the single widest possible range) is
 * much further back. Confirmed against real Robinhood Chain mainnet: an
 * unbounded scan from a token's launch block, and separately a scan from
 * block 0 (readLaunchRecord's old default), both failed outright against
 * real RPC providers' block-range limits. Chunking alone isn't enough —
 * it would turn one huge range into a huge *number* of sequential
 * requests, trading one rejected call for a near-certain rate-limit trip
 * instead. Capping the lookback bounds the number of chunks directly.
 *
 * Returns the (possibly capped) fromBlock and whether the result is
 * still a true, complete scan — false the moment the cap actually binds,
 * so callers never present a capped, partial-history result as complete.
 */
export function boundedScanStart(
  trueFromBlock: bigint,
  latestBlock: bigint,
  isCompleteCandidate: boolean,
  maxScanBlocks: bigint
): { fromBlock: bigint; isComplete: boolean } {
  const span = latestBlock - trueFromBlock;
  if (span <= maxScanBlocks) return { fromBlock: trueFromBlock, isComplete: isCompleteCandidate };
  const cappedFromBlock = latestBlock - maxScanBlocks;
  return { fromBlock: cappedFromBlock < 0n ? 0n : cappedFromBlock, isComplete: false };
}
