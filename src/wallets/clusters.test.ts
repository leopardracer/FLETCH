import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useInMemoryDbForTests } from "../persistence/db.js";
import { recordCurveScan, type CurveTrade } from "../persistence/walletTradesStore.js";
import { getLinkedWallets } from "./clusters.js";

const ME = "0x1111111111111111111111111111111111111111" as const;
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TA = "0x000000000000000000000000000000000000000a" as const;
const TB = "0x000000000000000000000000000000000000000b" as const;
const TC = "0x000000000000000000000000000000000000000c" as const;

beforeEach(() => {
  useInMemoryDbForTests();
});

let n = 0;
function buy(wallet: string, blockNumber: number): CurveTrade {
  return { wallet: wallet as `0x${string}`, txHash: `0x${(n++).toString(16)}`, logIndex: 0, blockNumber, side: "buy", tokenAmount: 100, quoteAmount: 1 };
}

test("a wallet that entered 2+ of the same tokens within 2 blocks of this one is linked", () => {
  recordCurveScan(TA, 100, 100, 500, [buy(ME, 110), buy(A, 111)]);
  recordCurveScan(TB, 100, 100, 500, [buy(ME, 205), buy(A, 205)]);
  const linked = getLinkedWallets(ME);
  assert.equal(linked.length, 1);
  assert.equal(linked[0].wallet, A);
  assert.equal(linked[0].sharedTokens, 2);
  assert.equal(linked[0].maxBlockGap, 1);
});

test("one shared token is noise — never a link on its own", () => {
  recordCurveScan(TA, 100, 100, 500, [buy(ME, 110), buy(A, 110)]);
  assert.deepEqual(getLinkedWallets(ME), []);
});

test("entries further apart than the gap don't count", () => {
  recordCurveScan(TA, 100, 100, 500, [buy(ME, 110), buy(A, 111)]);
  recordCurveScan(TB, 100, 100, 500, [buy(ME, 205), buy(A, 250)]);
  assert.deepEqual(getLinkedWallets(ME), []);
});

test("only FIRST buys are compared — a later top-up doesn't create a link", () => {
  recordCurveScan(TA, 100, 100, 500, [buy(ME, 110), buy(A, 111)]);
  recordCurveScan(TB, 100, 100, 500, [buy(ME, 205), buy(A, 150), buy(A, 206)]);
  assert.deepEqual(getLinkedWallets(ME), []);
});

test("sorted by shared tokens; the wallet itself never appears", () => {
  recordCurveScan(TA, 100, 100, 500, [buy(ME, 110), buy(A, 110), buy(B, 111)]);
  recordCurveScan(TB, 100, 100, 500, [buy(ME, 205), buy(A, 205), buy(B, 206)]);
  recordCurveScan(TC, 100, 100, 500, [buy(ME, 305), buy(A, 306)]);
  const linked = getLinkedWallets(ME);
  assert.deepEqual(linked.map((l) => [l.wallet, l.sharedTokens]), [[A, 3], [B, 2]]);
  assert.ok(linked.every((l) => l.wallet !== ME));
});

test("a wallet with no buys has no links", () => {
  assert.deepEqual(getLinkedWallets(ME), []);
});
