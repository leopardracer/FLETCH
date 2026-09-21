import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveGraduated } from "./launch.js";

/**
 * deriveGraduated is the one pure piece of readCurveState's honesty
 * fix — readCurveState/readLaunchRecord themselves need a live RPC and
 * aren't unit-tested, consistent with the rest of chain/*.ts.
 *
 * The bug this covers: a bounded scan finding no PoolGraduated event
 * only proves "not graduated within the window actually checked", not
 * "definitely never graduated" — the real event could be older than the
 * lookback cap (MAX_HOLDER_SCAN_BLOCKS). Before this fix, a capped scan
 * that found nothing silently reported graduated: false, which could
 * misrepresent an old, already-graduated token as still on the curve.
 */

test("an event was found: graduated is true, regardless of whether the scan was complete or capped", () => {
  assert.equal(deriveGraduated(true, true), true);
  assert.equal(deriveGraduated(true, false), true);
});

test("REGRESSION: no event found, but the scan covered the FULL launch-to-latest range: a real, confirmed false", () => {
  assert.equal(deriveGraduated(false, true), false);
});

test("REGRESSION: no event found, and the scan was capped short of the full range: genuinely unknown, not false", () => {
  assert.equal(deriveGraduated(false, false), null);
});
