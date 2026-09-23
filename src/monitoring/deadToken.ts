import type { TokenMetrics } from "../data/types.js";

export interface DeadCheckInput {
  metrics: Pick<TokenMetrics, "liquidityPairAsset" | "graduated">;
  /** Block of the last recorded curve trade (null = none recorded). */
  lastTradeBlock: number | null;
  /** The latest block FLETCH has scanned this token's curve through. */
  scannedThroughBlock: number | null;
  deadLiquidityEth: number;
  deadAfterBlocks: number;
}

/**
 * A launch is DEAD when all of these hold:
 *  - it hasn't graduated (graduated tokens trade elsewhere — not dead);
 *  - its curve holds less than DEAD_LIQUIDITY_ETH;
 *  - FLETCH has recorded at least one trade, and none in the last
 *    DEAD_AFTER_BLOCKS of scanned chain.
 * Anything unknown (no liquidity reading, no trade history, no scan) → not
 * dead: FLETCH never buries a token on missing data.
 */
export function isDeadToken(i: DeadCheckInput): boolean {
  if (i.metrics.graduated === true) return false;
  if (i.metrics.liquidityPairAsset === null || i.metrics.liquidityPairAsset >= i.deadLiquidityEth) return false;
  if (i.lastTradeBlock === null || i.scannedThroughBlock === null) return false;
  return i.scannedThroughBlock - i.lastTradeBlock >= i.deadAfterBlocks;
}
