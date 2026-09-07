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

/**
 * Holder stats for any token, computed via full Transfer log replay from
 * the launch block. This is a real, exact count — but it is O(transfers)
 * in RPC log volume per token, which is fine for one token on demand and
 * does not scale to "compute holder counts for every live token
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
  const isLifetime = launch.found;
  const fromBlock = launch.found
    ? launch.launchBlock
    : latest > config.signalWindowBlocks
    ? latest - config.signalWindowBlocks
    : 0n;

  const logs = await client.getLogs({
    address: tokenAddress,
    event: erc20Abi[0], // Transfer
    fromBlock,
    toBlock: latest,
  });

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
