import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useInMemoryDbForTests } from "./db.js";
import { recordCurveScan, getContiguousCoverageFromLaunch, getTradesForWallet, type CurveTrade } from "./walletTradesStore.js";

const TOKEN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const WALLET = "0xcccccccccccccccccccccccccccccccccccccccc" as const;

beforeEach(() => {
  useInMemoryDbForTests();
});

function trade(over: Partial<CurveTrade> = {}): CurveTrade {
  return { wallet: WALLET, txHash: "0x01", logIndex: 0, blockNumber: 105, side: "buy", tokenAmount: 1000, quoteAmount: 2, ...over };
}

test("a recorded trade stores its own price-at-trade (quote / tokens), not the token's latest price", () => {
  recordCurveScan(TOKEN, 100, 100, 200, [trade()]);
  const [t] = getTradesForWallet(WALLET);
  assert.equal(t.priceInPair, 0.002);
  assert.equal(t.token, TOKEN);
});

test("re-scanning overlapping blocks never double-counts the same trade", () => {
  recordCurveScan(TOKEN, 100, 100, 200, [trade()]);
  recordCurveScan(TOKEN, 100, 150, 250, [trade()]);
  assert.equal(getTradesForWallet(WALLET).length, 1);
});

test("the same tx with two different log indexes is two real trades", () => {
  recordCurveScan(TOKEN, 100, 100, 200, [trade({ logIndex: 0 }), trade({ logIndex: 1 })]);
  assert.equal(getTradesForWallet(WALLET).length, 2);
});

test("wallet addresses are matched case-insensitively", () => {
  recordCurveScan(TOKEN, 100, 100, 200, [trade({ wallet: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" })]);
  assert.equal(getTradesForWallet(WALLET).length, 1);
});

test("trades come back in true chain order (block, then log index), not insertion order", () => {
  recordCurveScan(TOKEN, 100, 100, 200, [
    trade({ txHash: "0x02", blockNumber: 150, logIndex: 1 }),
    trade({ txHash: "0x03", blockNumber: 150, logIndex: 0 }),
    trade({ txHash: "0x04", blockNumber: 120, logIndex: 5 }),
  ]);
  assert.deepEqual(
    getTradesForWallet(WALLET).map((t) => [t.blockNumber, t.logIndex]),
    [[120, 5], [150, 0], [150, 1]]
  );
});

test("no scans yet → coverage is null, not zero", () => {
  assert.equal(getContiguousCoverageFromLaunch(TOKEN), null);
});

test("a scan that started at the launch block gives coverage through its end", () => {
  recordCurveScan(TOKEN, 100, 100, 200, []);
  assert.equal(getContiguousCoverageFromLaunch(TOKEN), 200);
});

test("a scan capped after launch (older token) gives NO coverage — the start of its history was never seen", () => {
  recordCurveScan(TOKEN, 100, 5000, 25000, []);
  assert.equal(getContiguousCoverageFromLaunch(TOKEN), null);
});

test("overlapping and adjacent scans merge into one contiguous stretch", () => {
  recordCurveScan(TOKEN, 100, 100, 200, []);
  recordCurveScan(TOKEN, 100, 180, 300, []);
  recordCurveScan(TOKEN, 100, 301, 400, []);
  assert.equal(getContiguousCoverageFromLaunch(TOKEN), 400);
});

test("a gap between scans stops coverage at the gap — trades after it aren't trusted for PnL", () => {
  recordCurveScan(TOKEN, 100, 100, 200, []);
  recordCurveScan(TOKEN, 100, 500, 600, []); // blocks 201-499 never scanned
  assert.equal(getContiguousCoverageFromLaunch(TOKEN), 200);
});

test("a zero-token trade is never stored", () => {
  recordCurveScan(TOKEN, 100, 100, 200, [trade({ tokenAmount: 0 })]);
  assert.equal(getTradesForWallet(WALLET).length, 0);
});

test("REGRESSION: re-scanning a trade with better attribution corrects its wallet instead of keeping the intermediary", () => {
  const MIDDLE = "0x6505000000000000000000000000000000000000" as const;
  recordCurveScan(TOKEN, 100, 100, 200, [trade({ wallet: MIDDLE })]);
  recordCurveScan(TOKEN, 100, 100, 200, [trade({ wallet: WALLET })]);
  assert.equal(getTradesForWallet(MIDDLE).length, 0);
  assert.equal(getTradesForWallet(WALLET).length, 1);
});
