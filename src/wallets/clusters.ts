import { getDb } from "../persistence/db.js";

/**
 * Wallet clustering — coordinated entries, off data FLETCH already records
 * (wallet_trades: every curve buy with its block). Zero extra RPC calls.
 *
 * A wallet is "linked" to this one when both made their FIRST buy of the
 * same token within `maxBlockGap` blocks of each other, on at least
 * `minSharedTokens` different tokens. One shared token is noise (plenty of
 * strangers buy the same launch in the same block); the same tight timing
 * repeated across several tokens is the pattern bundlers and sniper
 * groups leave behind.
 *
 * Honest scope: this is a behavioral pattern, not proof of common
 * ownership — the API and every AI read say so. Funding-source tracing
 * (which wallet sent these wallets their ETH) needs native-transfer
 * history FLETCH doesn't index and is not claimed here.
 */
export const DEFAULT_MAX_BLOCK_GAP = 2;
export const DEFAULT_MIN_SHARED_TOKENS = 2;

export interface LinkedWallet {
  wallet: string;
  sharedTokens: number;
  tokens: string[];
  /** Largest first-buy block gap among the shared tokens. */
  maxBlockGap: number;
}

export function getLinkedWallets(
  wallet: `0x${string}`,
  maxBlockGap: number = DEFAULT_MAX_BLOCK_GAP,
  minSharedTokens: number = DEFAULT_MIN_SHARED_TOKENS,
  limit = 20
): LinkedWallet[] {
  const db = getDb();
  const me = wallet.toLowerCase();
  const rows = db
    .prepare(
      `WITH mine AS (
         SELECT token, MIN(block_number) AS b FROM wallet_trades WHERE wallet = ? AND side = 'buy' GROUP BY token
       ),
       others AS (
         SELECT wallet, token, MIN(block_number) AS b FROM wallet_trades
         WHERE side = 'buy' AND wallet <> ? AND token IN (SELECT token FROM mine)
         GROUP BY wallet, token
       )
       SELECT o.wallet AS wallet, o.token AS token, ABS(o.b - m.b) AS gap
       FROM others o JOIN mine m ON o.token = m.token
       WHERE ABS(o.b - m.b) <= ?`
    )
    .all(me, me, maxBlockGap) as { wallet: string; token: string; gap: number }[];

  const byWallet = new Map<string, { tokens: string[]; maxGap: number }>();
  for (const r of rows) {
    const e = byWallet.get(r.wallet) ?? { tokens: [], maxGap: 0 };
    e.tokens.push(r.token);
    e.maxGap = Math.max(e.maxGap, r.gap);
    byWallet.set(r.wallet, e);
  }
  return [...byWallet.entries()]
    .filter(([, e]) => e.tokens.length >= minSharedTokens)
    .map(([w, e]) => ({ wallet: w, sharedTokens: e.tokens.length, tokens: e.tokens.sort(), maxBlockGap: e.maxGap }))
    .sort((a, b) => b.sharedTokens - a.sharedTokens || a.maxBlockGap - b.maxBlockGap || a.wallet.localeCompare(b.wallet))
    .slice(0, limit);
}
