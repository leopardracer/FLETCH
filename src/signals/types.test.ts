import { test } from "node:test";
import assert from "node:assert/strict";
import { pickTopSignal, type Signal } from "./types.js";

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    type: "BUY_PRESSURE",
    severity: "LOW",
    confidence: 50,
    evidence: "e",
    explanation: "x",
    timestamp: 1_700_000_000,
    ...overrides,
  };
}

test("pickTopSignal returns null for an empty batch", () => {
  assert.equal(pickTopSignal([]), null);
});

test("pickTopSignal picks the highest-severity signal, not just the first one in the array — regression test for a real bug where the API used signals[0]", () => {
  const low = signal({ type: "PRICE_UP", severity: "LOW" });
  const critical = signal({ type: "HOLDER_CONCENTRATION", severity: "CRITICAL" });
  const medium = signal({ type: "BUY_PRESSURE", severity: "MEDIUM" });
  // CRITICAL is deliberately NOT first in the array, matching how the real
  // engine detects buy-pressure signals before risk-promoted ones.
  const picked = pickTopSignal([low, medium, critical]);
  assert.equal(picked, critical);
});

test("severity order is CRITICAL > HIGH > MEDIUM > LOW", () => {
  const high = signal({ severity: "HIGH" });
  const critical = signal({ severity: "CRITICAL" });
  assert.equal(pickTopSignal([high, critical]), critical);
  assert.equal(pickTopSignal([critical, high]), critical);
});

test("a single signal is returned regardless of its severity", () => {
  const only = signal({ severity: "LOW" });
  assert.equal(pickTopSignal([only]), only);
});
