import { test } from "node:test";
import assert from "node:assert/strict";
import { bigIntSafe } from "./jsonSafe.js";

test("a bare bigint becomes its decimal string, and JSON.stringify no longer throws on it", () => {
  const result = bigIntSafe(123456789n);
  assert.equal(result, "123456789");
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("a bigint nested inside an object is converted; sibling fields of other types are untouched", () => {
  const input = { ok: true, blockNumber: 987654321n, label: "curve", ratio: 0.5 };
  const result = bigIntSafe(input);
  assert.equal(result.blockNumber, "987654321");
  assert.equal(typeof result.blockNumber, "string");
  assert.equal(result.ok, true);
  assert.equal(result.label, "curve");
  assert.equal(result.ratio, 0.5);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("a bigint inside an array of objects (the real whaleMoves shape) is converted per-element", () => {
  const input = {
    whaleMoves: [
      { from: "0x1", to: "0x2", amount: 500, txHash: "0xabc", blockNumber: 111n },
      { from: "0x3", to: "0x4", amount: 900, txHash: "0xdef", blockNumber: 222n },
    ],
  };
  const result = bigIntSafe(input);
  assert.equal(result.whaleMoves[0].blockNumber, "111");
  assert.equal(result.whaleMoves[1].blockNumber, "222");
  assert.equal(typeof result.whaleMoves[0].amount, "number"); // untouched — not a bigint
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("regular numbers, including large ones, are never turned into strings", () => {
  const input = { count: 42, ratio: 3.14159, big: Number.MAX_SAFE_INTEGER };
  const result = bigIntSafe(input);
  assert.equal(result.count, 42);
  assert.equal(typeof result.count, "number");
  assert.equal(result.big, Number.MAX_SAFE_INTEGER);
});

test("null, undefined, booleans, and plain strings pass through completely unchanged", () => {
  assert.equal(bigIntSafe(null), null);
  assert.equal(bigIntSafe(undefined), undefined);
  assert.equal(bigIntSafe(true), true);
  assert.equal(bigIntSafe(false), false);
  assert.equal(bigIntSafe("hello"), "hello");
});

test("a deeply nested bigint (object inside array inside object) is still found and converted", () => {
  const input = { a: [{ b: { c: 5n } }] };
  const result = bigIntSafe(input);
  assert.equal(result.a[0].b.c, "5");
});

test("the original input is never mutated — bigIntSafe returns a new structure", () => {
  const input = { blockNumber: 42n };
  const result = bigIntSafe(input);
  assert.equal(typeof input.blockNumber, "bigint"); // still a real bigint on the original object
  assert.equal(result.blockNumber, "42");
});

test("a value with no bigint anywhere round-trips structurally unchanged", () => {
  const input = { a: 1, b: "two", c: [3, 4], d: { e: null } };
  assert.deepEqual(bigIntSafe(input), input);
});

test("the exact pingChain() success shape used by /api/health serializes cleanly end to end", () => {
  const chainResult = { ok: true as const, blockNumber: 4_829_301n };
  const response = { ok: chainResult.ok, chain: bigIntSafe(chainResult), blockscoutConfigured: false, pollerEnabled: true };
  const json = JSON.stringify(response); // this exact call is what crashed the process before the fix
  assert.equal(JSON.parse(json).chain.blockNumber, "4829301");
});
