/**
 * The data-access boundary. Everything above this layer (scoring, risk,
 * api) depends only on these types — never on viem, Blockscout, or any
 * specific provider directly. That's what lets a Bitquery-backed provider
 * (or any future one) be dropped in later without touching scoring/risk/UI.
 *
 * Every field that can't be sourced from real data must be `null`, not a
 * guess — see UNAVAILABLE handling in scoring/fletchScore.ts.
 */

export interface Token {
  address: `0x${string}`;
  symbol: string | null;
  name: string | null;
  deployer: `0x${string}` | null;
  launchBlock: bigint | null;
  launchTimestamp: number | null; // unix seconds, null if not resolved
  ageSeconds: number | null;
  graduated: boolean | null; // null = unknown (no launch record found)
}

export interface TokenMetrics {
  priceInPair: number | null;
  liquidityPairAsset: number | null;
  liquidityUsd: number | null;
  liquidityUsdUnavailableReason?: string;
  holderCount: number | null;
  holderCountIsLifetime: boolean;
  buyCountWindow: number;
  sellCountWindow: number;
  volumePairAssetWindow: number | null;
  topHolderConcentrationPercent: number | null; // % held by top 10 non-protocol accumulators
}

export interface Transfer {
  from: `0x${string}`;
  to: `0x${string}`;
  amount: number;
  txHash: `0x${string}`;
  blockNumber: bigint;
}

export interface Holder {
  address: `0x${string}`;
  balance: number;
}

export interface WalletActivity {
  wallet: `0x${string}`;
  tokensTraded: number; // distinct tokens this wallet has traded, where known
  note?: string; // e.g. "based on netChange within this token's scan window only"
}

export interface ChainDataProvider {
  /** Chain-wide new-token discovery — not scoped to one token. */
  getNewTokens(windowBlocks?: bigint): Promise<Token[]>;
  getTokenMetrics(address: `0x${string}`): Promise<TokenMetrics>;
  getTransfers(address: `0x${string}`): Promise<Transfer[]>;
  getHolders(address: `0x${string}`): Promise<Holder[]>;
  getWalletActivity(address: `0x${string}`): Promise<WalletActivity[]>;
}
