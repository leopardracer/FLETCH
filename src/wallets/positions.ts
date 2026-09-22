import type { StoredTrade } from "../persistence/walletTradesStore.js";

/**
 * Phase 4 — real per-position PnL from recorded price-at-trade, using the
 * average-cost method (every buy moves the cost basis; every sell realizes
 * (sell price − average cost) × tokens sold).
 *
 * Two honesty rules, both enforced here rather than in callers:
 *  1. Only trades inside a token's gap-free coverage from its launch block
 *     count. A trade FLETCH didn't see would make the cost basis wrong.
 *  2. If a wallet sells more tokens than FLETCH saw it buy on the curve
 *     (it got them by transfer, or before coverage began), that position's
 *     cost basis is unknown — it's marked UNKNOWN_COST_BASIS and excluded,
 *     never filled in with a zero or a guessed entry price.
 *
 * Amounts are in the pair asset (ETH on Pons V2 native-ETH launches), as
 * reported by the curve's own events. Post-graduation (Uniswap v4) trades
 * aren't read — see docs/DATA.md.
 */

/** Positions smaller than this fraction of the peak holding count as fully closed (dust from rounding). */
const CLOSED_DUST_FRACTION = 1e-6;

export type PositionStatus = "OPEN" | "CLOSED" | "UNKNOWN_COST_BASIS";

export interface Position {
  token: string;
  status: PositionStatus;
  tradesCounted: number;
  /** Realized PnL in the pair asset; null when the cost basis is unknown. */
  realizedPnlPair: number | null;
  tokensHeld: number;
  /** Pair-asset cost of the tokens still held (average-cost); 0 when closed, null when unknown. */
  costBasisPair: number | null;
  /** Blocks from first buy to full exit — CLOSED positions only, null otherwise. */
  holdingBlocks: number | null;
  firstBlock: number;
  lastBlock: number;
}

export function computePositions(
  trades: StoredTrade[],
  coveredThrough: (token: string) => number | null
): Position[] {
  const byToken = new Map<string, StoredTrade[]>();
  for (const t of trades) {
    const list = byToken.get(t.token) ?? [];
    list.push(t);
    byToken.set(t.token, list);
  }

  const positions: Position[] = [];
  for (const [token, all] of byToken) {
    const limit = coveredThrough(token);
    if (limit === null) continue; // no gap-free history from launch — nothing honest to say
    const tokenTrades = all
      .filter((t) => t.blockNumber <= limit)
      .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    if (tokenTrades.length === 0) continue;

    let held = 0;
    let costBasis = 0; // total pair-asset cost of the tokens currently held
    let realized = 0;
    let peak = 0;
    let unknownBasis = false;

    for (const t of tokenTrades) {
      if (t.side === "buy") {
        held += t.tokenAmount;
        costBasis += t.quoteAmount;
        peak = Math.max(peak, held);
      } else {
        if (t.tokenAmount > held * (1 + 1e-9)) {
          unknownBasis = true;
          break;
        }
        const avgCost = held > 0 ? costBasis / held : 0;
        realized += t.quoteAmount - avgCost * t.tokenAmount;
        costBasis -= avgCost * t.tokenAmount;
        held -= t.tokenAmount;
      }
    }

    const first = tokenTrades[0].blockNumber;
    const last = tokenTrades[tokenTrades.length - 1].blockNumber;
    if (unknownBasis) {
      positions.push({ token, status: "UNKNOWN_COST_BASIS", tradesCounted: tokenTrades.length, realizedPnlPair: null, tokensHeld: 0, costBasisPair: null, holdingBlocks: null, firstBlock: first, lastBlock: last });
      continue;
    }
    const closed = peak > 0 && held <= peak * CLOSED_DUST_FRACTION;
    positions.push({
      token,
      status: closed ? "CLOSED" : "OPEN",
      tradesCounted: tokenTrades.length,
      realizedPnlPair: realized,
      tokensHeld: closed ? 0 : held,
      costBasisPair: closed ? 0 : costBasis,
      holdingBlocks: closed ? last - first : null,
      firstBlock: first,
      lastBlock: last,
    });
  }
  return positions;
}

export interface PnlSummary {
  /** Sum of realized PnL across every position with a known cost basis. */
  realizedPnlPair: number;
  positionsCounted: number;
  closedPositions: number;
  /** Closed positions with realized PnL > 0. */
  winningClosedPositions: number;
  /** Positions excluded because FLETCH never saw the tokens being bought. */
  excludedUnknownCostBasis: number;
}

export function summarizePositions(positions: Position[]): PnlSummary {
  const known = positions.filter((p) => p.status !== "UNKNOWN_COST_BASIS");
  const closed = known.filter((p) => p.status === "CLOSED");
  return {
    realizedPnlPair: known.reduce((sum, p) => sum + (p.realizedPnlPair ?? 0), 0),
    positionsCounted: known.length,
    closedPositions: closed.length,
    winningClosedPositions: closed.filter((p) => (p.realizedPnlPair ?? 0) > 0).length,
    excludedUnknownCostBasis: positions.length - known.length,
  };
}

/**
 * Unrealized PnL for one OPEN position: tokens still held × the token's
 * current curve price − what they cost. Null (never a guess) unless every
 * condition for an honest number holds:
 *  - the position is OPEN with a known cost basis;
 *  - the token hasn't graduated (post-graduation v4 pricing isn't read);
 *  - the price is recent enough (maxPriceAgeSeconds);
 *  - FLETCH's gap-free coverage reaches its most recent scan — otherwise a
 *    sell after a gap could mean the wallet no longer holds these tokens.
 */
export interface MarkPrice {
  priceInPair: number | null;
  takenAt: number;
  graduated: boolean | null;
}

export function unrealizedPnlFor(
  p: Position,
  mark: MarkPrice | null,
  coverage: { coveredThrough: number | null; latestScannedTo: number } | null,
  now: number,
  maxPriceAgeSeconds: number
): number | null {
  if (p.status !== "OPEN" || p.costBasisPair === null) return null;
  if (!mark || mark.priceInPair === null || mark.graduated !== false) return null;
  if (now - mark.takenAt > maxPriceAgeSeconds) return null;
  if (!coverage || coverage.coveredThrough === null || coverage.coveredThrough < coverage.latestScannedTo) return null;
  return p.tokensHeld * mark.priceInPair - p.costBasisPair;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
