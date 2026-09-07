import { getWalletProfile, type WalletProfile } from "../persistence/walletActivityStore.js";

export type MetricAvailability = "REAL" | "UNAVAILABLE" | "NOT_YET_IMPLEMENTED";

export interface WalletIntelligence {
  wallet: string;
  /** Real, factual record of what FLETCH has actually observed — tokens
   *  touched, when tracking started/last updated. Not an opinion. */
  profile: WalletProfile | null;
  /**
   * Deliberately NOT a 0-100 "wallet score" yet. The brief's own example
   * score is built on early-entry timing and profitable exits — both need
   * price tracked at the moment of each trade, which this data model
   * doesn't capture yet (see persistence/walletActivityStore.ts). A
   * breadth-only proxy score ("touched N tokens") would be easy to compute
   * but easy to misread as a skill signal it isn't — so this stays
   * NOT_YET_IMPLEMENTED with the exact missing piece named, rather than
   * shipping a number that looks like the real thing.
   */
  metrics: Record<
    "winRate" | "earlyEntryTiming" | "realizedPnl" | "unrealizedPnl" | "averageHoldingPeriod" | "accumulationBehavior",
    { availability: MetricAvailability; reason?: string }
  >;
}

const NOT_IMPLEMENTED = (reason: string) => ({ availability: "NOT_YET_IMPLEMENTED" as const, reason });

export function getWalletIntelligence(wallet: `0x${string}`): WalletIntelligence {
  const profile = getWalletProfile(wallet);

  return {
    wallet: wallet.toLowerCase(),
    profile,
    metrics: {
      winRate: NOT_IMPLEMENTED("needs resolved win/loss outcomes per position — not tracked yet"),
      earlyEntryTiming: NOT_IMPLEMENTED("needs entry timestamp relative to each token's launch block, aggregated across trades — not tracked yet"),
      realizedPnl: NOT_IMPLEMENTED("needs price recorded at both entry and exit for each position — only net token-amount change is recorded today"),
      unrealizedPnl: NOT_IMPLEMENTED("needs a live cost basis per open position — not tracked yet"),
      averageHoldingPeriod: NOT_IMPLEMENTED("needs paired entry/exit timestamps per position — not tracked yet"),
      accumulationBehavior: profile
        ? { availability: "REAL" }
        : { availability: "UNAVAILABLE", reason: "no recorded activity for this wallet yet" },
    },
  };
}
