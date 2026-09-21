import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchLogsInChunks, boundedScanStart } from "./logScan.js";

/**
 * The two pure, shared log-scanning helpers used by holders.ts and
 * launch.ts, proven directly — the functions that actually call the RPC
 * (readHolderStats, readLaunchRecord, readCurveState) need a live
 * connection and aren't unit-tested, consistent with the rest of
 * chain/*.ts. Both were added after real Robinhood Chain mainnet testing
 * showed unbounded eth_getLogs ranges (one ~237,000 blocks, another
 * defaulting to a full from-genesis scan) getting rejected outright by
 * real RPC providers — including free tiers that cap a single call at
 * just 5-10 blocks.
 */

// ---------- fetchLogsInChunks ----------

test("a range smaller than one chunk makes exactly one call", async () => {
  const calls: any[] = [];
  const getLogs = async (range: any) => {
    calls.push(range);
    return [{ block: range.fromBlock }];
  };
  const result = await fetchLogsInChunks(getLogs, 100n, 150n, 2000n);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { fromBlock: 100n, toBlock: 150n });
  assert.equal(result.length, 1);
});

test("a range spanning several chunks is split exactly, with no gap and no overlap", async () => {
  const calls: { fromBlock: bigint; toBlock: bigint }[] = [];
  const getLogs = async (range: any) => {
    calls.push(range);
    return [];
  };
  await fetchLogsInChunks(getLogs, 0n, 4999n, 2000n);

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], { fromBlock: 0n, toBlock: 1999n });
  assert.deepEqual(calls[1], { fromBlock: 2000n, toBlock: 3999n });
  assert.deepEqual(calls[2], { fromBlock: 4000n, toBlock: 4999n }); // final partial chunk, not overshooting toBlock
});

test("results from every chunk are concatenated, in order", async () => {
  const getLogs = async (range: any) => [`log-at-${range.fromBlock}`];
  const result = await fetchLogsInChunks(getLogs, 0n, 5999n, 2000n);
  assert.deepEqual(result, ["log-at-0", "log-at-2000", "log-at-4000"]);
});

test("REGRESSION: the exact real failure this was built for — a ~237,000 block range — chunks into a bounded, predictable number of calls at the default chunk size", async () => {
  let callCount = 0;
  const getLogs = async () => {
    callCount++;
    return [];
  };
  await fetchLogsInChunks(getLogs, 0n, 236_905n, 2_000n);
  assert.equal(callCount, 119); // ceil(236906 / 2000)
});

test("a failure in any chunk propagates immediately — never returns partial results silently, since a partial holder count would be wrong, not just imprecise", async () => {
  let callCount = 0;
  const getLogs = async () => {
    callCount++;
    if (callCount === 2) throw new Error("Too Many Requests");
    return [{ ok: true }];
  };
  await assert.rejects(() => fetchLogsInChunks(getLogs, 0n, 5999n, 2000n), /Too Many Requests/);
  assert.equal(callCount, 2); // stopped immediately on the failing chunk — never attempted the third
});

test("fromBlock > toBlock returns an empty array without calling getLogs at all", async () => {
  let called = false;
  const getLogs = async () => {
    called = true;
    return [];
  };
  const result = await fetchLogsInChunks(getLogs, 100n, 50n, 2000n);
  assert.deepEqual(result, []);
  assert.equal(called, false);
});

test("a zero or negative chunk size is rejected outright, not silently treated as unbounded", async () => {
  await assert.rejects(() => fetchLogsInChunks(async () => [], 0n, 100n, 0n), /positive/);
});

// ---------- boundedScanStart ----------

test("a span within the cap is left untouched — isLifetime passes through unchanged", () => {
  const result = boundedScanStart(1000n, 5000n, true, 20_000n);
  assert.equal(result.fromBlock, 1000n);
  assert.equal(result.isComplete, true);
});

test("REGRESSION: a span exceeding the cap (the real ~237,000 block case) is capped, and isLifetime becomes false — never silently claimed as a true lifetime count", () => {
  const latest = 58_003_530n;
  const trueLaunchBlock = latest - 236_905n;
  const result = boundedScanStart(trueLaunchBlock, latest, true, 20_000n);
  assert.equal(result.fromBlock, latest - 20_000n);
  assert.equal(result.isComplete, false);
});

test("a span exactly at the cap is not treated as exceeding it", () => {
  const result = boundedScanStart(0n, 20_000n, true, 20_000n);
  assert.equal(result.fromBlock, 0n);
  assert.equal(result.isComplete, true);
});

test("isLifetime was already false (no launch record found) — capping never flips it back to true", () => {
  const result = boundedScanStart(0n, 100_000n, false, 20_000n);
  assert.equal(result.isComplete, false);
});

test("the capped fromBlock never goes negative, even on an extreme cap relative to chain height", () => {
  const result = boundedScanStart(0n, 100n, true, 20_000n);
  assert.equal(result.fromBlock >= 0n, true);
});
