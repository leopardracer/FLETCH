import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useInMemoryDbForTests } from "./db.js";
import { applyHolderDeltas, getHolderCoverage, getPositiveBalances } from "./holderStore.js";
import { topHolderConcentrationPercent } from "../chain/holders.js";

beforeEach(() => { useInMemoryDbForTests(); });
const T = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("deltas accumulate across checks into lifetime balances; coverage advances with them", () => {
  applyHolderDeltas(T, 100, 200, new Map([["0x1", 50n], ["0x2", 30n]]));
  applyHolderDeltas(T, 100, 300, new Map([["0x1", -50n], ["0x3", 5n]]));
  assert.deepEqual(getHolderCoverage(T), { launchBlock: 100, throughBlock: 300 });
  assert.deepEqual(getPositiveBalances(T).map((b) => [b.holder, b.balance]).sort(), [["0x2", 30n], ["0x3", 5n]]);
});

test("REGRESSION: concentration uses ALL holders as the denominator — not the top-10 list itself (was always 100%)", () => {
  const topAccumulators = Array.from({ length: 10 }, (_, i) => ({ address: `0x${i}`, netChange: 10 }));
  const pct = topHolderConcentrationPercent({ windowFromBlock: 0n, windowToBlock: 0n, isLifetime: true, holderCount: 50, topAccumulators, whaleMoves: [], totalHeld: 400 }, 10);
  assert.equal(pct, 25);
});
