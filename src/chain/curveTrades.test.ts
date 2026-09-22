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
