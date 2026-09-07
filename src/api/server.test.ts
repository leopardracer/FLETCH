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

const { createServer } = await import("./server.js");

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

test("GET /api/tokens fails gracefully (500 with a clear reason) when RPC isn't configured — never a raw crash or hang", async () => {
  const res = await fetch(`${baseUrl}/api/tokens`);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /RPC_URL/);
});

test("GET /api/tokens/:address (full token page) also fails gracefully without RPC, for the same reason", async () => {
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
