import { getDb } from "./db.js";

export function recordWalletActivity(
  wallet: `0x${string}`,
  token: `0x${string}`,
  netChange: number,
  priceInPair: number | null,
  now: number = Math.floor(Date.now() / 1000)
): void {
  const db = getDb();
  db.prepare(`INSERT INTO wallet_activity (wallet, token, taken_at, net_change, price_in_pair) VALUES (?, ?, ?, ?, ?)`).run(
    wallet.toLowerCase(),
    token.toLowerCase(),
    now,
    netChange,
    priceInPair
  );
}

export interface WalletProfile {
  wallet: string;
  tokensTouched: string[];
  firstSeenAt: number;
  lastSeenAt: number;
  totalRecords: number;
}

/**
 * What FLETCH can honestly say about a wallet from what it has actually
 * observed so far — no PnL, no win rate, no "smart money" label. Those
 * need price-at-entry tracked per trade over weeks-to-months of real
 * accumulation; this is the data model that would eventually support them
 * (see docs/DATA.md#smart-money), not the finished feature.
 */
export function getWalletProfile(wallet: `0x${string}`): WalletProfile | null {
  const db = getDb();
  const rows = db
    .prepare(`SELECT token, taken_at FROM wallet_activity WHERE wallet = ? ORDER BY taken_at ASC`)
    .all(wallet.toLowerCase()) as { token: string; taken_at: number }[];
  if (rows.length === 0) return null;
  const tokensTouched = [...new Set(rows.map((r) => r.token))];
  return {
    wallet: wallet.toLowerCase(),
    tokensTouched,
    firstSeenAt: rows[0].taken_at,
    lastSeenAt: rows[rows.length - 1].taken_at,
    totalRecords: rows.length,
  };
}
