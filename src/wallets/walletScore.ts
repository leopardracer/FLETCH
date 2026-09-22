import { getWalletProfile, type WalletProfile } from "../persistence/walletActivityStore.js";
import { getTradesForWallet, getContiguousCoverageFromLaunch, getTradeCoverage } from "../persistence/walletTradesStore.js";
import { getLatestSnapshot } from "../persistence/snapshots.js";
import { computePositions, summarizePositions, unrealizedPnlFor, median, type Position } from "./positions.js";

/** A curve price older than this isn't used to value an open position. */
const MAX_MARK_PRICE_AGE_SECONDS = 24 * 3600;

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

export function getWalletIntelligence(wallet: `0x${string}`, now: number = Math.floor(Date.now() / 1000)): WalletIntelligence {
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

  // Unrealized PnL — every OPEN position must be honestly valuable, or the
  // total would silently leave some out and read as smaller than it is.
  const open = positions.filter((p) => p.status === "OPEN");
  const unrealizedValues = open.map((p) =>
    unrealizedPnlFor(p, getLatestSnapshot(p.token as `0x${string}`), getTradeCoverage(p.token), now, MAX_MARK_PRICE_AGE_SECONDS)
  );
  const unvalued = unrealizedValues.filter((v) => v === null).length;
  const unrealizedPnl: WalletMetric =
    open.length === 0
      ? UNAVAILABLE("no open position with a known cost basis")
      : unvalued > 0
      ? UNAVAILABLE(
          `${unvalued} of ${open.length} open position(s) can't be valued honestly right now (graduated to Uniswap v4, ` +
            "no curve price in the last 24h, or a gap in scanned history) — no partial total is shown"
        )
      : {
          availability: "REAL",
          value: (unrealizedValues as number[]).reduce((a, b) => a + b, 0),
          unit: "ETH",
          reason: `${open.length} open position(s), each valued at its token's latest observed curve trade price`,
        };

  // Early entry — blocks from each token's launch to this wallet's first buy.
  // A known-cost-basis position always starts with a buy FLETCH saw from launch.
  const entries = positions
    .filter((p) => p.status !== "UNKNOWN_COST_BASIS")
    .map((p) => {
      const cov = getTradeCoverage(p.token);
      return cov ? Math.max(0, p.firstBlock - cov.launchBlock) : null;
    })
    .filter((v): v is number => v !== null);
  const medianEntry = median(entries);
  const earlyEntryTiming: WalletMetric =
    medianEntry === null
      ? UNAVAILABLE("no position with a first buy FLETCH saw from the token's launch block")
      : {
          availability: "REAL",
          value: medianEntry,
          unit: "blocks after launch (median)",
          reason: `median across ${entries.length} token(s); lower = earlier. In blocks, not seconds — per-trade timestamps aren't recorded`,
        };

  return {
    wallet: wallet.toLowerCase(),
    profile,
    positions,
    metrics: {
      winRate,
      realizedPnl,
      earlyEntryTiming,
      unrealizedPnl,
      averageHoldingPeriod: NOT_IMPLEMENTED("needs real timestamps for each entry/exit block — only block numbers are recorded per trade today"),
      accumulationBehavior: profile ? { availability: "REAL" } : UNAVAILABLE("no recorded activity for this wallet yet"),
    },
  };
}
