import { formatUnits } from "viem";
import { getClient } from "./client.js";
import { erc20Abi } from "./token.js";
import { readLaunchRecord } from "./launch.js";
import { PONS_PROTOCOL_ADDRESSES } from "./pons.js";
import { config } from "../core/config.js";
import { fetchLogsInChunks, boundedScanStart } from "./logScan.js";

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
  const { fromBlock, isComplete: isLifetime } = boundedScanStart(trueFromBlock, latest, launch.found, config.maxHolderScanBlocks);

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

  const core = computeHolderCore(
    logs.map((l) => ({ ...(l.args as { from: string; to: string; value: bigint }), txHash: l.transactionHash!, blockNumber: l.blockNumber! })),
    decimals,
    whaleThresholdTokens,
    launch.found ? launch.curve : null,
    top
  );
  const { holderCount, topAccumulators, whaleMoves } = core;
  return { windowFromBlock: fromBlock, windowToBlock: latest, isLifetime, holderCount, topAccumulators, whaleMoves };
}

export interface RawTransfer { from: string; to: string; value: bigint; txHash: string; blockNumber: bigint }

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * The pure part of readHolderStats — replays Transfer logs into holders,
 * accumulators and whale moves. Three rules found against real Robinhood
 * Chain data (token WALS, Sep 2026) that the first version got wrong:
 *
 *  1. The token's own bonding CURVE holds the unsold supply. It was being
 *     counted as a holder — so a token everyone had sold back showed
 *     "1 holder, top 10 own 100%" (a false CRITICAL) and the curve topped
 *     the wallet list. The curve and the zero address are never holders.
 *  2. The mint (from the zero address into the curve) was reported as a
 *     "1,000,000,000 tokens sold into the curve" whale sell. Mints and burns
 *     aren't trades — they're never whale moves.
 *  3. Many sells go wallet → intermediary contract → curve inside ONE tx
 *     (and buys curve → intermediary → wallet). That produced a spurious
 *     "wallet-to-wallet transfer" for every trade. An address that receives
 *     and forwards the exact same amount within one tx is a pass-through:
 *     the chain is collapsed into a single move from the real sender to the
 *     real receiver, and the pass-through is never a holder.
 */
export function computeHolderCore(
  transfers: RawTransfer[],
  decimals: number,
  whaleThresholdTokens: number,
  curve: string | null,
  top = 10
): Pick<HolderStats, "holderCount" | "topAccumulators" | "whaleMoves"> {
  const excluded = new Set<string>([...PROTOCOL_SET, ZERO]);
  if (curve) excluded.add(curve.toLowerCase());

  // 3. find pass-throughs per tx: in == out within the tx, both non-zero
  const byTx = new Map<string, RawTransfer[]>();
  for (const t of transfers) (byTx.get(t.txHash) ?? byTx.set(t.txHash, []).get(t.txHash)!).push(t);
  const passThrough = new Set<string>(); // "tx|address"
  const collapsed: RawTransfer[] = [];
  for (const [tx, list] of byTx) {
    const inAmt = new Map<string, bigint>(), outAmt = new Map<string, bigint>();
    for (const t of list) {
      const f = t.from.toLowerCase(), to = t.to.toLowerCase();
      outAmt.set(f, (outAmt.get(f) ?? 0n) + t.value);
      inAmt.set(to, (inAmt.get(to) ?? 0n) + t.value);
    }
    const pts = new Set<string>();
    for (const [addr, amt] of inAmt) if (addr !== ZERO && !excluded.has(addr) && outAmt.get(addr) === amt && amt > 0n) pts.add(addr);
    pts.forEach((a) => passThrough.add(tx + "|" + a));
    // collapse A -> X -> B chains (same amount) into A -> B for whale purposes
    const used = new Set<RawTransfer>();
    for (const t of list) {
      if (used.has(t)) continue;
      const to = t.to.toLowerCase();
      if (pts.has(to)) {
        const next = list.find((u) => !used.has(u) && u !== t && u.from.toLowerCase() === to && u.value === t.value);
        if (next) { used.add(t); used.add(next); collapsed.push({ ...t, to: next.to }); continue; }
      }
      if (pts.has(t.from.toLowerCase())) { const prev = list.find((u) => u.to.toLowerCase() === t.from.toLowerCase() && u.value === t.value); if (prev && used.has(prev)) continue; }
      used.add(t); collapsed.push(t);
    }
  }

  const balance = new Map<string, bigint>();
  const netChange = new Map<string, bigint>();
  for (const t of transfers) {
    balance.set(t.from.toLowerCase(), (balance.get(t.from.toLowerCase()) ?? 0n) - t.value);
    balance.set(t.to.toLowerCase(), (balance.get(t.to.toLowerCase()) ?? 0n) + t.value);
    netChange.set(t.from.toLowerCase(), (netChange.get(t.from.toLowerCase()) ?? 0n) - t.value);
    netChange.set(t.to.toLowerCase(), (netChange.get(t.to.toLowerCase()) ?? 0n) + t.value);
  }
  const isPass = (addr: string) => [...passThrough].some((k) => k.endsWith("|" + addr));

  let holderCount = 0;
  for (const [address, bal] of balance) if (bal > 0n && !excluded.has(address) && !isPass(address)) holderCount++;

  const topAccumulators = [...netChange.entries()]
    .filter(([address, ch]) => !excluded.has(address) && ch !== 0n)
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
    .slice(0, top)
    .map(([address, change]) => ({ address, netChange: Number(formatUnits(change, decimals)) }));

  const threshold = BigInt(Math.floor(whaleThresholdTokens)) * 10n ** BigInt(decimals);
  const whaleMoves: HolderStats["whaleMoves"] = collapsed
    .filter((t) => t.value >= threshold && t.from.toLowerCase() !== ZERO && t.to.toLowerCase() !== ZERO)
    .map((t) => ({ from: t.from, to: t.to, amount: Number(formatUnits(t.value, decimals)), txHash: t.txHash, blockNumber: t.blockNumber.toString() }));

  return { holderCount, topAccumulators, whaleMoves };
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
