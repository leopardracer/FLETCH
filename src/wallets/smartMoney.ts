export interface SmartMoneyWallet {
  address: `0x${string}`;
  winRatePercent: number;
  earlyEntries: number;
  averageEntryMinutes: number;
  recentTokens: { symbol: string; returnPercent: number }[];
}

export interface SmartMoneyAvailable {
  available: true;
  value: number; // 0-100 aggregate smart-money component score
  wallets: SmartMoneyWallet[];
}

export interface SmartMoneyUnavailable {
  available: false;
  reason: string;
}

export type SmartMoneyReport = SmartMoneyAvailable | SmartMoneyUnavailable;

/**
 * Real win-rate / early-entry / historical-performance tracking needs
 * either (a) a persistence layer that accumulates per-wallet outcomes
 * across every token FLETCH has ever scored, run for weeks-to-months, or
 * (b) an indexer with that history already built (Bitquery's decoded
 * trade tables, or a purpose-built wallet-intelligence API).
 *
 * Neither exists yet in this MVP. Per the product brief's own principle
 * ("if historical data is insufficient, do not fabricate statistics"),
 * this returns an explicit UNAVAILABLE rather than a plausible-looking
 * fake wallet leaderboard. Wire a real backing store or provider here
 * before enabling the "Smart Money" tab.
 */
export async function getSmartMoneyForToken(_tokenAddress: `0x${string}`): Promise<SmartMoneyReport> {
  return {
    available: false,
    reason:
      "no wallet-performance history store or indexer wired up yet — needs either persisted " +
      "cross-token tracking over time or a provider like Bitquery's decoded trade history",
  };
}
