import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeCurveTrade } from "./curveTrades.js";

const USER = "0x1111111111111111111111111111111111111111";
const ROUTER = "0xe33e9e479df8802cb0866d5d05258bec4cf62948";
const TX = "0xabc0000000000000000000000000000000000000000000000000000000000001" as const;
const E18 = 10n ** 18n;

test("a CurveBuy decodes to a buy attributed to the recipient, with exact amounts", () => {
  const t = decodeCurveTrade({
    args: { buyer: ROUTER, recipient: USER, quoteIn: 2n * E18, tokensOut: 1000n * E18, fee: 0n, tax: 0n },
    transactionHash: TX,
    logIndex: 3,
    blockNumber: 100n,
  });
  assert.ok(t);
  assert.equal(t!.side, "buy");
  assert.equal(t!.wallet, USER); // not the router that called the curve
  assert.equal(t!.tokenAmount, 1000);
  assert.equal(t!.quoteAmount, 2);
  assert.equal(t!.blockNumber, 100);
  assert.equal(t!.logIndex, 3);
});

test("a CurveSell decodes to a sell attributed to the recipient of the proceeds", () => {
  const t = decodeCurveTrade({
    args: { seller: ROUTER, recipient: USER, tokensIn: 500n * E18, quoteOut: 3n * E18, fee: 0n, tax: 0n },
    transactionHash: TX,
    logIndex: 0,
    blockNumber: 200n,
  });
  assert.equal(t!.side, "sell");
  assert.equal(t!.wallet, USER);
  assert.equal(t!.tokenAmount, 500);
  assert.equal(t!.quoteAmount, 3);
});

test("a zero-token trade carries no price and is dropped, never recorded as price 0 or Infinity", () => {
  assert.equal(
    decodeCurveTrade({ args: { recipient: USER, quoteIn: E18, tokensOut: 0n }, transactionHash: TX, logIndex: 0, blockNumber: 1n }),
    null
  );
});

test("a pending log (no tx hash / log index / block yet) is dropped rather than stored with a guessed position", () => {
  assert.equal(
    decodeCurveTrade({ args: { recipient: USER, quoteIn: E18, tokensOut: E18 }, transactionHash: null, logIndex: null, blockNumber: null }),
    null
  );
});

test("args that match neither event shape decode to null", () => {
  assert.equal(
    decodeCurveTrade({ args: { recipient: USER, foo: 1n }, transactionHash: TX, logIndex: 0, blockNumber: 1n }),
    null
  );
});

// ---------- attribution by token flow (real shapes: WALS, Sep 2026) ----------
import { attributeByTokenFlow } from "./curveTrades.js";
import { computeHolderCore } from "./holders.js";

const CURVE = "0xd5cf30ea17cb90584f8cf7f4b882e555a64230bc";
const MIDDLE = "0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc"; // credited with 115 of 1,147 trades before the fix
const BUYER = "0x4f44ef3fc60d4a81426fea2756cb892277852fbd";
const WEI = 10n ** 18n;

test("REGRESSION: a buy routed curve → intermediary → buyer is credited to the BUYER, not the intermediary", () => {
  const core = computeHolderCore([{ from: CURVE, to: MIDDLE, value: 1_117_101n * WEI, txHash: "0xb1", blockNumber: 1n },
                                  { from: MIDDLE, to: BUYER, value: 1_117_101n * WEI, txHash: "0xb1", blockNumber: 1n }], 18, 1e12, CURVE);
  const [t] = attributeByTokenFlow([{ wallet: MIDDLE as `0x${string}`, txHash: "0xb1", logIndex: 0, blockNumber: 1, side: "buy", tokenAmount: 1_117_101, quoteAmount: 0.01 }], core.flows!, CURVE);
  assert.equal(t.wallet.toLowerCase(), BUYER);
});

test("REGRESSION: a sell routed seller → intermediary → curve is credited to the SELLER", () => {
  const core = computeHolderCore([{ from: BUYER, to: MIDDLE, value: 1_117_101n * WEI, txHash: "0xs1", blockNumber: 2n },
                                  { from: MIDDLE, to: CURVE, value: 1_117_101n * WEI, txHash: "0xs1", blockNumber: 2n }], 18, 1e12, CURVE);
  const [t] = attributeByTokenFlow([{ wallet: MIDDLE as `0x${string}`, txHash: "0xs1", logIndex: 0, blockNumber: 2, side: "sell", tokenAmount: 1_117_101, quoteAmount: 0.009 }], core.flows!, CURVE);
  assert.equal(t.wallet.toLowerCase(), BUYER);
});

test("a direct trade keeps its recipient; an ambiguous flow keeps the event's recipient rather than guessing", () => {
  const direct = attributeByTokenFlow([{ wallet: BUYER as `0x${string}`, txHash: "0xd", logIndex: 0, blockNumber: 3, side: "buy", tokenAmount: 10, quoteAmount: 1 }],
    [{ from: CURVE, to: BUYER, amount: 10, txHash: "0xd" }], CURVE);
  assert.equal(direct[0].wallet, BUYER);
  const ambiguous = attributeByTokenFlow([{ wallet: MIDDLE as `0x${string}`, txHash: "0xa", logIndex: 0, blockNumber: 4, side: "buy", tokenAmount: 10, quoteAmount: 1 }],
    [{ from: CURVE, to: "0x" + "1".repeat(40), amount: 7, txHash: "0xa" }, { from: CURVE, to: "0x" + "2".repeat(40), amount: 8, txHash: "0xa" }], CURVE);
  assert.equal(ambiguous[0].wallet, MIDDLE);
});
