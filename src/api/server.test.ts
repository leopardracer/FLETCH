import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";

/**
 * End-to-end smoke tests: boot the real Express app and hit it over real
 * HTTP, exactly as a browser would. No mocking of Express itself.
 *
 * Network/DB isolation: RPC_URL is forced empty and DB_PATH is forced to
 * an in-memory SQLite database BEFORE the app (and therefore core/config.ts)
 * is ever imported — using a top-level await + dynamic import so this
 * runs before any static import of app code executes. That guarantees:
 *   1. zero real network calls, even if the machine running this has a
 *      real RPC_URL in its own shell environment — this test's process
 *      never sees it;
 *   2. zero writes to a real fletch.db file.
 * node --test runs each test file in its own child process (verified
 * separately), so these env overrides never leak into other test files.
 */
process.env.RPC_URL = "";
process.env.BLOCKSCOUT_API_KEY = "";
process.env.DB_PATH = ":memory:";
process.env.ENABLE_POLLER = "false";

const { createServer, buildHealthResponse } = await import("./server.js");

let server: Server;
let baseUrl: string;

before(async () => {
  const app = createServer();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close();
});

const TOKEN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET = "0xcccccccccccccccccccccccccccccccccccccccc";

test("GET /api/health responds 200 and honestly reports RPC as unconfigured — never claims a connection that doesn't exist", async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.chain.reason, /RPC_URL is not set/);
  assert.equal(body.blockscoutConfigured, false);
  assert.equal(body.pollerEnabled, false);
});

test("REGRESSION: buildHealthResponse (the exact function GET /api/health calls) never throws on a real bigint block number — this crashed the entire process in live testing", () => {
  // This test suite runs with RPC_URL unset (see the top of this file), so
  // pingChain()'s real success branch — the one that returns an actual
  // bigint block number from viem — is never exercised through a live
  // HTTP request here. buildHealthResponse is the literal code the real
  // handler calls with that result, so testing it directly with the exact
  // shape pingChain() returns on success is testing the real fix, not a
  // re-implementation of it.
  const fakeSuccessfulPing = { ok: true as const, blockNumber: 4_829_301n };
  const response = buildHealthResponse(fakeSuccessfulPing, true, true);

  assert.doesNotThrow(() => JSON.stringify(response)); // this exact line is what crashed the process before the fix
  const parsed = JSON.parse(JSON.stringify(response));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.chain.blockNumber, "4829301");
  assert.equal(typeof parsed.chain.blockNumber, "string");
});

test("REGRESSION: buildHealthResponse still reports a real failure normally — the fix didn't change the ok:false shape", () => {
  const response = buildHealthResponse({ ok: false, reason: "RPC_URL is not set in .env" }, false, false);
  assert.equal(response.ok, false);
  assert.equal((response.chain as { reason: string }).reason, "RPC_URL is not set in .env");
  assert.doesNotThrow(() => JSON.stringify(response));
});

test("GET /api/signals responds 200 with an empty feed on a fresh database — not an error", async () => {
  const res = await fetch(`${baseUrl}/api/signals`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { count: 0, signals: [] });
});

test("GET /api/radar responds 200 with an empty list on a fresh database — no signals, no candidates, not an error", async () => {
  const res = await fetch(`${baseUrl}/api/radar`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.radar, []);
  assert.equal(body.count, 0);
  assert.equal(body.windowSeconds, 1800);
});

test("GET /api/radar honors a custom window query param", async () => {
  const res = await fetch(`${baseUrl}/api/radar?window=600`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.windowSeconds, 600);
});

test("GET /api/monitoring responds 200 with real counts on a fresh database, and never exposes RPC_URL or other secrets", async () => {
  const res = await fetch(`${baseUrl}/api/monitoring`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.totalMonitored, 0);
  assert.equal(body.activeCount, 0);
  assert.equal(body.dueNowCount, 0);
  assert.equal(typeof body.enabled, "boolean");
  assert.equal("rpcUrl" in body, false);
  assert.equal("RPC_URL" in body, false);
  assert.equal("blockscoutApiKey" in body, false);
});

test("GET /api/monitoring exposes `rpcConfigured` and `running` as real, distinct facts alongside `enabled` — the dashboard needs the actual truth, not just the config flag", async () => {
  const res = await fetch(`${baseUrl}/api/monitoring`);
  const body = await res.json();
  // This suite runs with ENABLE_POLLER=false and RPC_URL unset (see the
  // top of this file), so all three are false here — but `running` is a
  // distinct, independently-computed field (enabled && rpcConfigured),
  // not an alias for `enabled`, which is what made the dashboard show
  // "WATCHING" even when the poller never started with RPC_URL unset.
  assert.equal(body.enabled, false);
  assert.equal(body.rpcConfigured, false);
  assert.equal(body.running, false);
  assert.equal(body.running, body.enabled && body.rpcConfigured);
});

test("GET /api/tokens fails gracefully (500 with a clear reason) when RPC isn't configured — never a raw crash or hang", async () => {
  const res = await fetch(`${baseUrl}/api/tokens`);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /RPC_URL/);
});

test("GET /api/tokens/:address (full token page) also fails gracefully without RPC, for the same reason", async () => {
  // Also exercises the code path around bigIntSafe(metrics) — see
  // jsonSafe.test.ts for the direct unit tests proving that
  // TokenMetrics.whaleMoves[].blockNumber (a real bigint) serializes
  // safely; a live whale-move-bearing token isn't reachable from this
  // offline suite, so the exact transformation is tested directly there
  // instead of re-derived here.
  const res = await fetch(`${baseUrl}/api/tokens/${TOKEN}`);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /RPC_URL/);
});

test("GET /api/tokens/:address/history responds 200 with an empty array for a token with no persisted snapshots — this endpoint needs no RPC at all", async () => {
  const res = await fetch(`${baseUrl}/api/tokens/${TOKEN}/history`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.address, TOKEN);
  assert.deepEqual(body.snapshots, []);
});

test("GET /api/tokens/:address/signals responds 200 with an empty array for a token with no persisted signals", async () => {
  const res = await fetch(`${baseUrl}/api/tokens/${TOKEN}/signals`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.signals, []);
});

test("GET /api/wallets/:address responds 200 with real wallet intelligence — every skill metric explicitly NOT_YET_IMPLEMENTED, no RPC needed", async () => {
  const res = await fetch(`${baseUrl}/api/wallets/${WALLET}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.wallet, WALLET);
  assert.equal(body.profile, null);
  assert.equal(body.metrics.realizedPnl.availability, "NOT_YET_IMPLEMENTED");
  assert.equal(body.metrics.winRate.availability, "NOT_YET_IMPLEMENTED");
});

test("GET / serves the dashboard shell", async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<html/i);
});

test("an unknown route responds 404, not a 500 or a hang", async () => {
  const res = await fetch(`${baseUrl}/api/this-route-does-not-exist`);
  assert.equal(res.status, 404);
});

test("a malformed token address is rejected with a clear 400 before it ever reaches a chain call — this used to silently fall through", async () => {
  const res = await fetch(`${baseUrl}/api/tokens/not-a-real-address/history`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /Invalid address/);
});

test("address validation applies consistently across every :address route, not just one endpoint", async () => {
  const paths = [
    `/api/tokens/not-a-real-address`,
    `/api/tokens/not-a-real-address/signals`,
    `/api/tokens/not-a-real-address/wallets`,
    `/api/wallets/not-a-real-address`,
    `/api/tokens/0x123/history`, // too short to be a real address
  ];
  for (const p of paths) {
    const res = await fetch(`${baseUrl}${p}`);
    assert.equal(res.status, 400, `expected 400 for ${p}, got ${res.status}`);
  }
});

test("a well-formed address is accepted and reaches the real route logic (fails on missing RPC, not on address format)", async () => {
  const res = await fetch(`${baseUrl}/api/tokens/${TOKEN}/history`);
  assert.equal(res.status, 200);
});
