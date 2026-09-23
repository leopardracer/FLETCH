import { test } from "node:test";
import assert from "node:assert/strict";
import { computeHolderCore, type RawTransfer } from "./holders.js";

// Shapes taken from real Robinhood Chain data: token WALS (0x4f9e…81a4), Sep 2026.
const ZERO = "0x0000000000000000000000000000000000000000";
const CURVE = "0xd5cf30ea17cb90584f8cf7f4b882e555a64230bc";
const MID = "0x9a0694264bbbd6860008ae19fc9fc914fcd911fa"; // forwards sells to the curve inside one tx
const A = "0xa06c627344058022526080cae9f8e44333c9a1c9";
const B = "0x5d60d79994f7bf3265f3515e7685c50aac8125bd";
const C = "0x1c37a18494c1a9ca77b6ba351d082f98394b51ba";
const E18 = 10n ** 18n;
let n = 0;
const t = (from: string, to: string, tokens: number, tx?: string): RawTransfer =>
  ({ from, to, value: BigInt(tokens) * E18, txHash: tx ?? `0x${(n++).toString(16)}`, blockNumber: 70453146n + BigInt(n) });

test("REGRESSION (WALS): the bonding curve is never a holder — a token everyone sold back isn't '1 holder, 100% concentrated'", () => {
  const core = computeHolderCore([t(ZERO, CURVE, 1_000_000_000), t(CURVE, A, 64_796_259), t(A, CURVE, 64_796_259)], 18, 1_000_000, CURVE);
  assert.equal(core.holderCount, 0);
  assert.equal(core.topAccumulators.some((h) => h.address === CURVE), false);
});

test("REGRESSION (WALS): the mint into the curve is not reported as a 1,000,000,000-token whale sell", () => {
  const core = computeHolderCore([t(ZERO, CURVE, 1_000_000_000)], 18, 1_000_000, CURVE);
  assert.deepEqual(core.whaleMoves, []);
});

test("REGRESSION (WALS): wallet → intermediary → curve in one tx is ONE sell by the wallet, not a sell plus a wallet-to-wallet transfer", () => {
  const core = computeHolderCore([t(CURVE, B, 37_438_751), t(B, MID, 37_438_751, "0xsell"), t(MID, CURVE, 37_438_751, "0xsell")], 18, 1_000_000, CURVE);
  const sells = core.whaleMoves.filter((w) => w.txHash === "0xsell");
  assert.equal(sells.length, 1);
  assert.equal(sells[0].from, B);
  assert.equal(sells[0].to, CURVE);
  assert.equal(core.topAccumulators.some((h) => h.address === MID), false);
});

test("real holders still count, and the top accumulator is a person, not the curve", () => {
  const core = computeHolderCore([t(ZERO, CURVE, 1_000_000_000), t(CURVE, A, 5_000_000), t(CURVE, C, 2_000_000)], 18, 1_000_000, CURVE);
  assert.equal(core.holderCount, 2);
  assert.equal(core.topAccumulators[0].address, A);
});

test("an ordinary wallet-to-wallet transfer is still reported as one", () => {
  const core = computeHolderCore([t(CURVE, A, 5_000_000), t(A, C, 3_000_000, "0xgift")], 18, 1_000_000, CURVE);
  const gift = core.whaleMoves.find((w) => w.txHash === "0xgift")!;
  assert.equal(gift.from, A);
  assert.equal(gift.to, C);
});

test("below the whale threshold nothing is reported", () => {
  assert.deepEqual(computeHolderCore([t(CURVE, A, 10)], 18, 1_000_000, CURVE).whaleMoves, []);
});
