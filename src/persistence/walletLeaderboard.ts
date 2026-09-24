import { getDb } from "./db.js";
import { NATIVE_ETH } from "../chain/pons.js";

/**
 * Wallets page: who is actually trading on Pons V2 curves right now,
 * computed only from the curve trades FLETCH has already recorded
 * (wallet_trades) — no chain read, no guess.
 *
 * - Only native-ETH launches are included, so every amount is in ETH and
 *   sums are meaningful (an ERC-20-paired curve's quote amounts are in a
 *   different unit and would corrupt the totals).
 * - The window is measured in blocks back from the newest recorded trade,
 *   so it never depends on a live RPC call.
 * - "Net flow" is ETH received from sells minus ETH spent on buys inside
 *   the window. It is cash flow, not profit: a wallet that bought before
 *   the window and sold inside it shows a positive flow either way. The
 *   per-wallet page has the real cost-basis PnL.
 */

export type LeaderboardSort = "active" | "buyers" | "sellers";

export interface LeaderboardRow {
  wallet: string;
  trades: number;
  buys: number;
  sells: number;
  tokens: number;
  ethBought: number;
  ethSold: number;
  netFlow: number;
  lastBlock: number;
}

export interface Leaderboard {
  sort: LeaderboardSort;
  windowBlocks: number;
  /** Newest block FLETCH has a recorded trade for — the window ends here. */
  latestBlock: number | null;
  fromBlock: number | null;
  totalWallets: number;
  totalTrades: number;
  wallets: LeaderboardRow[];
}

const ORDER: Record<LeaderboardSort, string> = {
  active: "trades DESC, ethBought + ethSold DESC",
  buyers: "ethBought DESC, trades DESC",
  sellers: "ethSold DESC, trades DESC",
};

/** `token` narrows everything to one token's curve (its page shows its own top traders). */
export function getWalletLeaderboard(opts: { windowBlocks: number; sort?: LeaderboardSort; limit?: number; token?: string }): Leaderboard {
  const sort: LeaderboardSort = opts.sort && ORDER[opts.sort] ? opts.sort : "active";
  const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
  const windowBlocks = Math.max(1, Math.floor(opts.windowBlocks));
  const db = getDb();

  const token = opts.token ? opts.token.toLowerCase() : null;
  const latest = (token
    ? db.prepare(`SELECT MAX(block_number) AS b FROM wallet_trades WHERE token = ?`).get(token)
    : db.prepare(`SELECT MAX(block_number) AS b FROM wallet_trades`).get()) as { b: number | null };
  if (latest.b === null) {
    return { sort, windowBlocks, latestBlock: null, fromBlock: null, totalWallets: 0, totalTrades: 0, wallets: [] };
  }
  const fromBlock = latest.b - windowBlocks + 1;

  const scope = `
    FROM wallet_trades w
    JOIN launch_records l ON l.token = w.token
   WHERE w.block_number >= ?
     AND lower(json_extract(l.record_json, '$.pairToken')) = ?
     ${token ? "AND w.token = ?" : ""}`;
  const args: (string | number)[] = token ? [fromBlock, NATIVE_ETH, token] : [fromBlock, NATIVE_ETH];

  const totals = db.prepare(`SELECT COUNT(DISTINCT w.wallet) AS wallets, COUNT(*) AS trades ${scope}`).get(...args) as {
    wallets: number; trades: number;
  };

  const rows = db
    .prepare(
      `SELECT w.wallet AS wallet,
              COUNT(*) AS trades,
              SUM(CASE WHEN w.side = 'buy'  THEN 1 ELSE 0 END) AS buys,
              SUM(CASE WHEN w.side = 'sell' THEN 1 ELSE 0 END) AS sells,
              COUNT(DISTINCT w.token) AS tokens,
              SUM(CASE WHEN w.side = 'buy'  THEN w.quote_amount ELSE 0 END) AS ethBought,
              SUM(CASE WHEN w.side = 'sell' THEN w.quote_amount ELSE 0 END) AS ethSold,
              MAX(w.block_number) AS lastBlock
       ${scope}
       GROUP BY w.wallet
       ORDER BY ${ORDER[sort]}
       LIMIT ?`
    )
    .all(...args, limit) as Omit<LeaderboardRow, "netFlow">[];

  return {
    sort,
    windowBlocks,
    latestBlock: latest.b,
    fromBlock,
    totalWallets: totals.wallets,
    totalTrades: totals.trades,
    wallets: rows.map((r) => ({ ...r, netFlow: r.ethSold - r.ethBought })),
  };
}
