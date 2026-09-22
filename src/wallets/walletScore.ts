import { getWalletProfile, type WalletProfile } from "../persistence/walletActivityStore.js";
import { getTradesForWallet, getContiguousCoverageFromLaunch } from "../persistence/walletTradesStore.js";
import { computePositions, summarizePositions, type Position } from "./positions.js";

export type MetricAvailability = "REAL" | "UNAVAILABLE" | "NOT_YET_IMPLEMENTED";

export interface WalletMetric {
  availability: MetricAvailability;
  /** Present only when availability is REAL. */
  value?: number;
  /** Unit of `value`, e.g. "ETH" or "percent". */
  unit?: string;
  reason?: string;
}

export interface WalletIntelligence {
  wallet: string;
  /** Real, factual record of what FLETCH has actually observed — tokens
   *  touched, when tracking started/last updated. Not an opinion. */
  profile: WalletProfile | null;
  /**
   * Per-token positions built from real price-at-trade (Phase 4) — only
   * over each token's gap-free curve history from launch. See wallets/positions.ts.
   */
  positions: Position[];
  /**
   * Still deliberately NOT a 0-100 "wallet score". Realized PnL and win
   * rate are now real numbers when FLETCH has the trades to back them;
   * everything that still needs data it doesn't have stays
   * NOT_YET_IMPLEMENTED / UNAVAILABLE with the exact reason named.
   */
  metrics: Record<
    "winRate" | "earlyEntryTiming" | "realizedPnl" | "unrealizedPnl" | "averageHoldingPeriod" | "accumulationBehavior",
    WalletMetric
  >;
}

const NOT_IMPLEMENTED = (reason: string): WalletMetric => ({ availability: "NOT_YET_IMPLEMENTED", reason });
const UNAVAILABLE = (reason: string): WalletMetric => ({ availability: "UNAVAILABLE", reason });

export function getWalletIntelligence(wallet: `0x${string}`): WalletIntelligence {
  const profile = getWalletProfile(wallet);
  const positions = computePositions(getTradesForWallet(wallet), getContiguousCoverageFromLaunch);
  const summary = summarizePositions(positions);

  const realizedPnl: WalletMetric =
    summary.positionsCounted > 0
      ? { availability: "REAL", value: summary.realizedPnlPair, unit: "ETH" }
      : UNAVAILABLE(
          summary.excludedUnknownCostBasis > 0
            ? "every observed position for this wallet sold tokens FLETCH never saw it buy on the curve — cost basis unknown, so no PnL is claimed"
            : "no curve trades recorded for this wallet inside a token's gap-free history from launch yet"
        );

  const winRate: WalletMetric =
    summary.closedPositions > 0
      ? {
          availability: "REAL",
          value: (summary.winningClosedPositions / summary.closedPositions) * 100,
          unit: "percent",
          reason: `${summary.winningClosedPositions} of ${summary.closedPositions} fully closed position(s) realized a profit`,
        }
      : UNAVAILABLE("no fully closed position with a known cost basis yet — a win or loss isn't decided until the position is closed");

  return {
    wallet: wallet.toLowerCase(),
    profile,
    positions,
    metrics: {
      winRate,
      realizedPnl,
      earlyEntryTiming: NOT_IMPLEMENTED("needs entry timing relative to each token's launch, aggregated across tokens — not computed yet"),
      unrealizedPnl: NOT_IMPLEMENTED("needs a live post-trade price per open position, including post-graduation Uniswap v4 pricing — not wired up yet"),
      averageHoldingPeriod: NOT_IMPLEMENTED("needs real timestamps for each entry/exit block — only block numbers are recorded per trade today"),
      accumulationBehavior: profile ? { availability: "REAL" } : UNAVAILABLE("no recorded activity for this wallet yet"),
    },
  };
}
