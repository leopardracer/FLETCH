import { getDb } from "./db.js";

/**
 * Phase 4 — price-at-trade. Every row here is one real CurveBuy/CurveSell
 * event off a token's own Pons V2 bonding curve, with the price implied by
 * that exact trade. See wallets/positions.ts for what's computed from it.
 */

export type TradeSide = "buy" | "sell";

export interface CurveTrade {
  wallet: `0x${string}`;
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: number;
  side: TradeSide;
  /** Token amount, human units. */
  tokenAmount: number;
  /** Pair-asset (ETH) amount, human units, exactly as the event reports it. */
  quoteAmount: number;
}

export interface StoredTrade extends CurveTrade {
  token: string;
  priceInPair: number;
}

interface TradeRow {
  wallet: string;
  token: string;
  tx_hash: string;
  log_index: number;
  block_number: number;
  side: TradeSide;
  token_amount: number;
  quote_amount: number;
  price_in_pair: number;
}

/**
 * Records one completed scan of a token's curve over [scannedFrom, scannedTo]
 * and every trade found in it. Idempotent: re-recording a trade already seen
 * (same tx hash + log index) is a no-op, so overlapping scans never double-count.
 * Trades with a zero token amount carry no price and are skipped, never stored as 0.
 */
export function recordCurveScan(
  token: `0x${string}`,
  launchBlock: number,
  scannedFrom: number,
  scannedTo: number,
  trades: CurveTrade[]
): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO wallet_trades
       (wallet, token, tx_hash, log_index, block_number, side, token_amount, quote_amount, price_in_pair)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.exec("BEGIN");
  try {
    for (const t of trades) {
      if (!(t.tokenAmount > 0)) continue;
      insert.run(
        t.wallet.toLowerCase(),
        token.toLowerCase(),
        t.txHash.toLowerCase(),
        t.logIndex,
        t.blockNumber,
        t.side,
        t.tokenAmount,
        t.quoteAmount,
        t.quoteAmount / t.tokenAmount
      );
    }
    db.prepare(`INSERT INTO trade_scan_coverage (token, launch_block, from_block, to_block) VALUES (?, ?, ?, ?)`).run(
      token.toLowerCase(),
      launchBlock,
      scannedFrom,
      scannedTo
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * The last block up to which this token's curve history is known with no
 * gaps, starting from its launch block — or null if the launch block itself
 * was never scanned (e.g. every scan so far was capped by MAX_HOLDER_SCAN_BLOCKS
 * for an older token). Merges overlapping/adjacent ranges; stops at the first gap.
 */
export function getContiguousCoverageFromLaunch(token: string): number | null {
  const db = getDb();
  const rows = db
    .prepare(`SELECT launch_block, from_block, to_block FROM trade_scan_coverage WHERE token = ? ORDER BY from_block ASC`)
    .all(token.toLowerCase()) as { launch_block: number; from_block: number; to_block: number }[];
  if (rows.length === 0) return null;
  const launchBlock = rows[0].launch_block;
  let coveredThrough = launchBlock - 1;
  for (const r of rows) {
    if (r.from_block > coveredThrough + 1) break;
    coveredThrough = Math.max(coveredThrough, r.to_block);
  }
  return coveredThrough >= launchBlock ? coveredThrough : null;
}

/** Every recorded trade for a wallet, in true chain order (block, then log index). */
export function getTradesForWallet(wallet: `0x${string}`): StoredTrade[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM wallet_trades WHERE wallet = ? ORDER BY token, block_number ASC, log_index ASC`)
    .all(wallet.toLowerCase()) as unknown as TradeRow[];
  return rows.map((r) => ({
    wallet: r.wallet as `0x${string}`,
    token: r.token,
    txHash: r.tx_hash as `0x${string}`,
    logIndex: r.log_index,
    blockNumber: r.block_number,
    side: r.side,
    tokenAmount: r.token_amount,
    quoteAmount: r.quote_amount,
    priceInPair: r.price_in_pair,
  }));
}
