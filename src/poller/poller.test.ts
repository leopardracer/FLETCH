import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * poller.ts's own scheduling logic (setInterval, the per-token try/catch
 * loop) genuinely needs a live RPC to exercise meaningfully — its actual
 * work (analyzeAndPersist) is already covered end-to-end by
 * signals/signalService.test.ts. What's worth testing in isolation,
 * without a live RPC or timer mocking, is the ENABLE_POLLER off-switch
 * itself: the same class of bug as the ENABLE_POLLER=false footgun fixed
 * in core/config.ts (see core/config.test.ts) would silently start a
 * poller that was supposed to be disabled.
 *
 * RPC_URL is forced empty and ENABLE_POLLER=false BEFORE the first
 * (and only) import of poller.js in this process — see
 * api/server.test.ts for why that ordering matters with config.ts's
 * parse-once-at-import design.
 */
process.env.RPC_URL = "";
process.env.ENABLE_POLLER = "false";
process.env.DB_PATH = ":memory:";

const { startPoller } = await import("./poller.js");

test("startPoller() with ENABLE_POLLER=false logs that it's disabled and schedules nothing", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalSetInterval = globalThis.setInterval;
  let intervalScheduled = false;

  console.log = (msg: string) => logs.push(String(msg));
  // @ts-expect-error — intentionally stubbing for this test only, restored immediately after
  globalThis.setInterval = () => {
    intervalScheduled = true;
    return 0 as unknown as NodeJS.Timeout;
  };

  try {
    startPoller();
  } finally {
    console.log = originalLog;
    globalThis.setInterval = originalSetInterval;
  }

  assert.ok(logs.some((l) => /disabled/i.test(l) && /ENABLE_POLLER=false/.test(l)));
  assert.equal(intervalScheduled, false, "a disabled poller must never schedule a recurring interval");
});
