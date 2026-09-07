import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useInMemoryDbForTests } from "./db.js";
import { recordSignal, getRecentSignals, getSignalsForToken, getSignalsForTokenSince, getDistinctTokensWithRecentSignals } from "./signalsStore.js";
import type { Signal } from "../signals/types.js";

const TOKEN_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const TOKEN_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const NOW = 1_700_000_000;

beforeEach(() => {
  useInMemoryDbForTests();
});

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    type: "BUY_PRESSURE",
    severity: "MEDIUM",
    confidence: 70,
    evidence: "10 buys vs 2 sells",
    explanation: "Buy pressure.",
    timestamp: NOW,
    ...overrides,
  };
}

test("an empty database returns an empty feed, not an error", () => {
  assert.deepEqual(getRecentSignals(), []);
});

test("a recorded signal round-trips with every field intact", () => {
  recordSignal(TOKEN_A, signal({ evidence: "18 buys vs 1 sell", blockNumber: "12345" }));
  const [s] = getRecentSignals();
  assert.equal(s.token, TOKEN_A);
  assert.equal(s.evidence, "18 buys vs 1 sell");
  assert.equal(s.blockNumber, "12345");
  assert.equal(s.timestamp, NOW);
});

test("the live feed sorts by severity first — CRITICAL before HIGH before MEDIUM before LOW — regardless of insertion order", () => {
  recordSignal(TOKEN_A, signal({ severity: "LOW", timestamp: NOW + 300 }));
  recordSignal(TOKEN_A, signal({ severity: "CRITICAL", timestamp: NOW }));
  recordSignal(TOKEN_A, signal({ severity: "MEDIUM", timestamp: NOW + 200 }));
  recordSignal(TOKEN_A, signal({ severity: "HIGH", timestamp: NOW + 100 }));

  const feed = getRecentSignals();
  assert.deepEqual(
    feed.map((s) => s.severity),
    ["CRITICAL", "HIGH", "MEDIUM", "LOW"]
  );
});

test("within the same severity, more recent signals come first", () => {
  recordSignal(TOKEN_A, signal({ severity: "HIGH", timestamp: NOW, evidence: "older" }));
  recordSignal(TOKEN_A, signal({ severity: "HIGH", timestamp: NOW + 500, evidence: "newer" }));

  const feed = getRecentSignals();
  assert.deepEqual(
    feed.map((s) => s.evidence),
    ["newer", "older"]
  );
});

test("getRecentSignals respects the limit parameter", () => {
  for (let i = 0; i < 10; i++) recordSignal(TOKEN_A, signal({ timestamp: NOW + i }));
  assert.equal(getRecentSignals(3).length, 3);
});

test("getSignalsForToken only returns that token's own signals, most recent first", () => {
  recordSignal(TOKEN_A, signal({ timestamp: NOW, evidence: "a-old" }));
  recordSignal(TOKEN_A, signal({ timestamp: NOW + 100, evidence: "a-new" }));
  recordSignal(TOKEN_B, signal({ timestamp: NOW + 200, evidence: "b-newest" }));

  const forA = getSignalsForToken(TOKEN_A);
  assert.deepEqual(
    forA.map((s) => s.evidence),
    ["a-new", "a-old"]
  );
  assert.ok(forA.every((s) => s.token === TOKEN_A));
});

test("token addresses are matched case-insensitively, same as everywhere else in the app", () => {
  recordSignal(TOKEN_A, signal());
  const upper = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as const;
  const found = getSignalsForToken(upper);
  assert.equal(found.length, 1);
});

test("getSignalsForTokenSince only returns signals at or after the cutoff, regardless of how much older history exists", () => {
  recordSignal(TOKEN_A, signal({ timestamp: NOW - 3600 })); // 1h old — outside the window
  recordSignal(TOKEN_A, signal({ timestamp: NOW - 60 })); // 1m old — inside
  recordSignal(TOKEN_A, signal({ timestamp: NOW })); // just now — inside
  const recent = getSignalsForTokenSince(TOKEN_A, NOW - 1800); // 30 min window
  assert.equal(recent.length, 2);
  assert.ok(recent.every((s) => s.timestamp >= NOW - 1800));
});

test("getSignalsForTokenSince never leaks another token's signals", () => {
  recordSignal(TOKEN_A, signal({ timestamp: NOW }));
  recordSignal(TOKEN_B, signal({ timestamp: NOW }));
  const recent = getSignalsForTokenSince(TOKEN_A, NOW - 60);
  assert.equal(recent.length, 1);
});

test("getDistinctTokensWithRecentSignals returns each token once, even with multiple recent signals", () => {
  recordSignal(TOKEN_A, signal({ timestamp: NOW }));
  recordSignal(TOKEN_A, signal({ timestamp: NOW - 10, type: "HOLDER_GROWTH" }));
  recordSignal(TOKEN_B, signal({ timestamp: NOW }));
  const tokens = getDistinctTokensWithRecentSignals(NOW - 60);
  assert.equal(tokens.length, 2);
  assert.ok(tokens.includes(TOKEN_A));
  assert.ok(tokens.includes(TOKEN_B));
});

test("getDistinctTokensWithRecentSignals excludes a token whose only signals are outside the window — a quiet token isn't a radar candidate", () => {
  recordSignal(TOKEN_A, signal({ timestamp: NOW - 7200 })); // 2h old
  const tokens = getDistinctTokensWithRecentSignals(NOW - 1800); // 30 min window
  assert.equal(tokens.length, 0);
});
