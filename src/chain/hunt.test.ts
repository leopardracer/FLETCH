import { test } from "node:test";
import assert from "node:assert/strict";
import { enrichOneLaunch } from "./hunt.js";

/**
 * enrichOneLaunch's own resilience — proven directly, with a fake
 * fetchEnrichment, rather than trusting a try/catch is there by
 * inspection. scanRecentLaunches itself needs a live RPC and isn't
 * unit-tested, matching the rest of chain/*.ts (see docs/DEVELOPMENT.md);
 * this is the piece of it that genuinely can be tested deterministically,
 * and is exactly the piece that was the real bug: one rate-limited
 * launch used to lose every other launch found in the same scan.
 */

function rawLog(overrides: Partial<{ curve: `0x${string}`; deployer: `0x${string}`; token: `0x${string}` }> = {}) {
  return {
    args: {
      token: overrides.token ?? ("0x1111111111111111111111111111111111111111" as const),
      curve: overrides.curve ?? ("0x2222222222222222222222222222222222222222" as const),
      deployer: overrides.deployer ?? ("0x3333333333333333333333333333333333333333" as const),
      pairToken: "0x0000000000000000000000000000000000000000" as const,
      launchConfigId: 0n,
      graduationThreshold: 1_000_000n,
    },
    blockNumber: 12345n,
    transactionHash: "0xabc" as const,
  };
}

test("a successful enrichment fills in real dev-buy and exempt-wallet data", async () => {
  const log = rawLog();
  const fakeFetch = async () => ({
    buyLogsInTx: [{ transactionHash: "0xabc" as const, args: { tokensOut: 5_000_000_000_000_000_000n, quoteIn: 1_000_000_000_000_000_000n, tax: 100_000_000_000_000_000n } }],
    exemptLogsInTx: [{ transactionHash: "0xabc" as const }, { transactionHash: "0xabc" as const }],
  });

  const result = await enrichOneLaunch(log, 1, fakeFetch);

  assert.equal(result.token, log.args.token);
  assert.equal(result.devBuyTokens, 5);
  assert.equal(result.devBuyTaxBps, 1000); // 0.1 tax / 1.0 quoteIn * 10000
  assert.equal(result.exemptWalletCount, 2);
});

test("REGRESSION: a failed enrichment (e.g. rate limit) still returns a real DetectedLaunch for a real launch — never dropped", async () => {
  const log = rawLog();
  const failingFetch = async (): Promise<never> => {
    throw new Error("HTTP request failed: Too Many Requests");
  };

  const result = await enrichOneLaunch(log, 1, failingFetch);

  // The launch itself is real and known — none of this should be lost:
  assert.equal(result.token, log.args.token);
  assert.equal(result.curve, log.args.curve);
  assert.equal(result.deployer, log.args.deployer);
  assert.equal(result.launchBlock, 12345n);
});

test("REGRESSION: on enrichment failure, dev-buy/exempt-wallet fields are null (unavailable), never fabricated as zero", async () => {
  const failingFetch = async (): Promise<never> => {
    throw new Error("Too Many Requests");
  };
  const result = await enrichOneLaunch(rawLog(), 1, failingFetch);

  assert.equal(result.devBuyTokens, null);
  assert.equal(result.devBuyTaxBps, null);
  assert.equal(result.exemptWalletCount, null);
});

test("a genuinely clean launch (enrichment succeeded, found nothing) is a real, confirmed zero — distinct from null", async () => {
  const cleanFetch = async () => ({ buyLogsInTx: [], exemptLogsInTx: [] });
  const result = await enrichOneLaunch(rawLog(), 1, cleanFetch);

  assert.equal(result.exemptWalletCount, 0); // confirmed zero, not null
  assert.notEqual(result.exemptWalletCount, null);
  assert.equal(result.devBuyTokens, null); // no matching dev-buy tx found — genuinely never happened
});

test("deployerLaunchCountInWindow is passed through unchanged — it's computed once, from the whole batch, before per-launch enrichment runs", async () => {
  const failingFetch = async (): Promise<never> => {
    throw new Error("rate limited");
  };
  const result = await enrichOneLaunch(rawLog(), 7, failingFetch);
  assert.equal(result.deployerLaunchCountInWindow, 7);
});

test("a successful timestamp read fills in the real launchTimestamp, independent of enrichment", async () => {
  const cleanFetch = async () => ({ buyLogsInTx: [], exemptLogsInTx: [] });
  const fakeTimestamp = async () => 1_700_000_000;
  const result = await enrichOneLaunch(rawLog(), 1, cleanFetch, fakeTimestamp);
  assert.equal(result.launchTimestamp, 1_700_000_000);
});

test("REGRESSION: a failed timestamp read (rate limit, RPC blip) leaves launchTimestamp null but still returns the real launch — never fabricated, never drops the launch", async () => {
  const cleanFetch = async () => ({ buyLogsInTx: [], exemptLogsInTx: [] });
  const failingTimestamp = async (): Promise<never> => {
    throw new Error("Too Many Requests");
  };
  const result = await enrichOneLaunch(rawLog(), 1, cleanFetch, failingTimestamp);
  assert.equal(result.launchTimestamp, null);
  assert.equal(result.token, rawLog().args.token); // the launch itself is still there
});

test("REGRESSION: the timestamp read and the enrichment read fail independently — one failing never drags the other down with it", async () => {
  const failingEnrichment = async (): Promise<never> => {
    throw new Error("enrichment rate limited");
  };
  const fakeTimestamp = async () => 1_700_000_000;
  // Enrichment fails, timestamp succeeds:
  const a = await enrichOneLaunch(rawLog(), 1, failingEnrichment, fakeTimestamp);
  assert.equal(a.devBuyTokens, null); // enrichment's failure
  assert.equal(a.launchTimestamp, 1_700_000_000); // timestamp still succeeded

  // Enrichment succeeds, timestamp fails:
  const cleanFetch = async () => ({ buyLogsInTx: [], exemptLogsInTx: [] });
  const failingTimestamp = async (): Promise<never> => {
    throw new Error("timestamp rate limited");
  };
  const b = await enrichOneLaunch(rawLog(), 1, cleanFetch, failingTimestamp);
  assert.equal(b.exemptWalletCount, 0); // enrichment still succeeded (real, confirmed zero)
  assert.equal(b.launchTimestamp, null); // timestamp's failure
});
