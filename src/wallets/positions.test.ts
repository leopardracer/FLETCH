import { test } from "node:test";
import assert from "node:assert/strict";
import { computePositions, summarizePositions, unrealizedPnlFor, median } from "./positions.js";
import type { StoredTrade } from "../persistence/walletTradesStore.js";

const WALLET = "0xcccccccccccccccccccccccccccccccccccccccc" as const;
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

let seq = 0;
function t(token: string, side: "buy" | "sell", tokenAmount: number, quoteAmount: number, blockNumber: number): StoredTrade {
  return { wallet: WALLET, token, txHash: `0x${(seq++).toString(16)}`, logIndex: 0, blockNumber, side, tokenAmount, quoteAmount, priceInPair: quoteAmount / tokenAmount };
}
const fullyCovered = () => 1_000_000;

test("buy then sell everything at a higher price → CLOSED, realized profit = proceeds − cost", () => {
  const [p] = computePositions([t(A, "buy", 1000, 1, 10), t(A, "sell", 1000, 1.5, 20)], fullyCovered);
  assert.equal(p.status, "CLOSED");
  assert.ok(Math.abs(p.realizedPnlPair! - 0.5) < 1e-12);
  assert.equal(p.tokensHeld, 0);
});

test("average cost across two buys at different prices is used for the sell", () => {
  // 1000 @ 0.001 + 1000 @ 0.003 → avg 0.002; sell 1000 @ 0.004 → +2.0 realized
  const [p] = computePositions([t(A, "buy", 1000, 1, 10), t(A, "buy", 1000, 3, 11), t(A, "sell", 1000, 4, 12)], fullyCovered);
  assert.equal(p.status, "OPEN");
  assert.ok(Math.abs(p.realizedPnlPair! - 2) < 1e-12);
  assert.equal(p.tokensHeld, 1000);
});

test("selling more than FLETCH saw bought → UNKNOWN_COST_BASIS with PnL null, never a guess", () => {
  const [p] = computePositions([t(A, "buy", 100, 1, 10), t(A, "sell", 500, 5, 20)], fullyCovered);
  assert.equal(p.status, "UNKNOWN_COST_BASIS");
  assert.equal(p.realizedPnlPair, null);
});

test("a token without gap-free coverage from launch produces no position at all", () => {
  const positions = computePositions([t(A, "buy", 1000, 1, 10), t(A, "sell", 1000, 2, 20)], () => null);
  assert.deepEqual(positions, []);
});

test("trades past the end of gap-free coverage are ignored, not counted on top of a gap", () => {
  const [p] = computePositions([t(A, "buy", 1000, 1, 10), t(A, "sell", 1000, 2, 900)], () => 500);
  assert.equal(p.status, "OPEN");
  assert.equal(p.tradesCounted, 1);
  assert.equal(p.realizedPnlPair, 0);
});

test("rounding dust left after a full exit still counts as CLOSED", () => {
  const [p] = computePositions([t(A, "buy", 1000, 1, 10), t(A, "sell", 999.9999999, 0.5, 20)], fullyCovered);
  assert.equal(p.status, "CLOSED");
});

test("summary: win rate inputs count only closed positions with known cost basis", () => {
  const positions = computePositions(
    [
      t(A, "buy", 1000, 1, 10), t(A, "sell", 1000, 2, 20), // closed win +1
      t(B, "buy", 1000, 2, 10), t(B, "sell", 1000, 1, 20), // closed loss −1
    ],
    fullyCovered
  );
  const s = summarizePositions(positions);
  assert.equal(s.closedPositions, 2);
  assert.equal(s.winningClosedPositions, 1);
  assert.ok(Math.abs(s.realizedPnlPair) < 1e-12);
  assert.equal(s.excludedUnknownCostBasis, 0);
});

test("summary excludes unknown-cost-basis positions from PnL and counts them separately", () => {
  const positions = computePositions([t(A, "sell", 10, 1, 10), t(B, "buy", 10, 1, 10)], fullyCovered);
  const s = summarizePositions(positions);
  assert.equal(s.positionsCounted, 1);
  assert.equal(s.excludedUnknownCostBasis, 1);
});

test("cost basis follows average cost: partial sell keeps the average, removes the sold share", () => {
  const [p] = computePositions([t(A, "buy", 1000, 1, 10), t(A, "buy", 1000, 3, 11), t(A, "sell", 500, 2, 12)], fullyCovered);
  assert.ok(Math.abs(p.costBasisPair! - 3) < 1e-12); // 1500 left × avg 0.002
});

test("unrealizedPnlFor refuses every case it can't back with real data", () => {
  const [open] = computePositions([t(A, "buy", 1000, 1, 10)], fullyCovered);
  const mark = { priceInPair: 0.002, takenAt: 1000, graduated: false };
  const cov = { coveredThrough: 500, latestScannedTo: 500 };
  assert.equal(unrealizedPnlFor(open, mark, cov, 1000, 3600), 1);
  assert.equal(unrealizedPnlFor(open, { ...mark, graduated: null }, cov, 1000, 3600), null);
  assert.equal(unrealizedPnlFor(open, { ...mark, priceInPair: null }, cov, 1000, 3600), null);
  assert.equal(unrealizedPnlFor(open, mark, { coveredThrough: 400, latestScannedTo: 500 }, 1000, 3600), null);
  assert.equal(unrealizedPnlFor(open, mark, cov, 1000 + 3601, 3600), null);
  assert.equal(unrealizedPnlFor(open, null, cov, 1000, 3600), null);
  const [closed] = computePositions([t(A, "buy", 10, 1, 10), t(A, "sell", 10, 2, 11)], fullyCovered);
  assert.equal(unrealizedPnlFor(closed, mark, cov, 1000, 3600), null);
});

test("median handles odd, even and empty inputs", () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});
