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
process.env.ANTHROPIC_API_KEY = ""; // AI routes must work (deterministically) with no key — and never call out from tests

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

test("buildHealthResponse surfaces the RPC backoff state when given one — so a paused poller is visible, not silent", () => {
  const response = buildHealthResponse({ ok: false, reason: "HTTP request failed." }, false, true, {
    paused: true, resumeAt: 1_700_003_600, consecutiveRateLimits: 1, lastReason: "provider daily request quota reached",
  });
  assert.equal(response.rpcBackoff?.paused, true);
  assert.equal(response.rpcBackoff?.lastReason, "provider daily request quota reached");
  assert.equal("rpcBackoff" in buildHealthResponse({ ok: false, reason: "x" }, false, false), false);
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

test("GET /api/wallets/:address responds 200 with real wallet intelligence — no recorded trades means UNAVAILABLE PnL/win rate, never a number, no RPC needed", async () => {
  const res = await fetch(`${baseUrl}/api/wallets/${WALLET}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.wallet, WALLET);
  assert.equal(body.profile, null);
  assert.deepEqual(body.positions, []);
  assert.equal(body.metrics.realizedPnl.availability, "UNAVAILABLE");
  assert.equal(body.metrics.realizedPnl.value, undefined);
  assert.equal(body.metrics.winRate.availability, "UNAVAILABLE");
  assert.equal(body.metrics.winRate.value, undefined);
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

test("the rate limiter returns 429 past its configured cap — on a dedicated server with a tiny limit, isolated from the shared one every other test in this file uses, so this doesn't trip 429s for them", async () => {
  const limitedApp = createServer({ rateLimit: { windowMs: 60_000, limit: 3 } });
  const limitedServer = limitedApp.listen(0);
  await new Promise<void>((resolve) => limitedServer.once("listening", resolve));
  const addr = limitedServer.address();
  const limitedBaseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

  try {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${limitedBaseUrl}/api/health`);
      statuses.push(res.status);
    }
    // First 3 (the configured limit) go through as normal 200s; the 4th
    // and 5th are rejected before ever reaching the route handler.
    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);

    const rejected = await fetch(`${limitedBaseUrl}/api/health`);
    const body = await rejected.json();
    assert.match(body.error, /Too many requests/);
  } finally {
    limitedServer.close();
  }
});

test("a static/dashboard path is never rate-limited by the /api limiter, even past its cap", async () => {
  const limitedApp = createServer({ rateLimit: { windowMs: 60_000, limit: 2 } });
  const limitedServer = limitedApp.listen(0);
  await new Promise<void>((resolve) => limitedServer.once("listening", resolve));
  const addr = limitedServer.address();
  const limitedBaseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

  try {
    // Exhaust the tiny /api limit first.
    for (let i = 0; i < 3; i++) await fetch(`${limitedBaseUrl}/api/health`);
    // The static dashboard (served from web/, not under the /api limiter)
    // must still respond normally — the rate limit is scoped to /api only.
    const res = await fetch(`${limitedBaseUrl}/index.html`);
    assert.notEqual(res.status, 429);
  } finally {
    limitedServer.close();
  }
});

// ---------- AI routes ----------

async function withServer<T>(opts: Parameters<typeof createServer>[0], fn: (base: string) => Promise<T>): Promise<T> {
  const app = createServer(opts);
  const srv = app.listen(0);
  await new Promise<void>((resolve) => srv.once("listening", resolve));
  const addr = srv.address();
  try {
    return await fn(`http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`);
  } finally {
    srv.close();
  }
}

test("GET /api/ai reports the server AI as disabled with no key — never the key itself", async () => {
  const res = await fetch(`${baseUrl}/api/ai`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { enabled: false, model: null });
});

test("GET /api/brief works with no key and no data: an honest 'nothing yet' fact, tagged as deterministic", async () => {
  const res = await fetch(`${baseUrl}/api/brief`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.aiEnabled, false);
  assert.equal(body.summary.source, "DETERMINISTIC_FALLBACK");
  assert.ok(body.facts.length >= 1);
  assert.match(body.summary.text, /hasn't recorded any on-chain activity|no on-chain signal fired/);
});

test("GET /api/wallets/:address?summary=ai adds the fact list and a summary, without changing the plain response", async () => {
  const plain = await (await fetch(`${baseUrl}/api/wallets/${WALLET}`)).json();
  const withAi = await (await fetch(`${baseUrl}/api/wallets/${WALLET}?summary=ai`)).json();
  assert.equal("naturalLanguageSummary" in plain, false);
  assert.equal(withAi.naturalLanguageSummary.source, "DETERMINISTIC_FALLBACK");
  assert.match(withAi.naturalLanguageSummary.text, /no recorded activity/);
  assert.deepEqual(withAi.metrics, plain.metrics);
});

test("GET /api/tokens/:address/ai-summary is a clean 404 until the token's report was actually loaded — it never invents facts on its own", async () => {
  const res = await fetch(`${baseUrl}/api/tokens/${TOKEN}/ai-summary`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.error, /load GET \/api\/tokens\/:address first/);
});

test("POST /api/chat has its own stricter per-IP limit, separate from the general /api limit", async () => {
  await withServer({ chatRateLimit: { windowMs: 60_000, limit: 2 } }, async (base) => {
    const post = () =>
      fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      });
    const statuses = [(await post()).status, (await post()).status, (await post()).status];
    assert.deepEqual(statuses, [200, 200, 429]);
    // other /api routes on the same server are unaffected
    assert.equal((await fetch(`${base}/api/ai`)).status, 200);
  });
});

// ---------- served from stored reports (no chain reads) ----------
const { saveReport } = await import("../persistence/reportStore.js");

test("GET /api/tokens/:address serves a fresh stored report without touching the chain (RPC_URL is unset here)", async () => {
  const T = "0x00000000000000000000000000000000000000c1";
  saveReport(T, { token: { address: T, symbol: "CACHE" }, whyIsItMoving: { bullets: ["b"], risks: ["r"], insufficientData: false } });
  const res = await fetch(`${baseUrl}/api/tokens/${T}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.source, "cache");
  assert.equal(body.token.symbol, "CACHE");
  assert.equal(typeof body.asOf, "number");
  // and the AI card can use it right away
  assert.equal((await fetch(`${baseUrl}/api/tokens/${T}/ai-summary`)).status, 200);
});

test("GET /api/tokens builds the feed from stored reports once there are enough — instant, sorted by score", async () => {
  for (let i = 0; i < 6; i++) {
    const T = `0x${(0xd0 + i).toString(16).padStart(40, "0")}`;
    saveReport(T, { token: { symbol: `T${i}` }, fletchScore: { overall: 10 * i }, risk: { level: "LOW" }, signals: [] });
  }
  const t0 = Date.now();
  const res = await fetch(`${baseUrl}/api/tokens`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.source, "cache");
  assert.ok(body.count >= 6);
  assert.ok(Date.now() - t0 < 2000);
  const scores = body.tokens.map((r: { fletchScore: number | null }) => r.fletchScore ?? -1);
  assert.deepEqual(scores, [...scores].sort((a: number, b: number) => b - a));
});

test("GET /healthz is a pure liveness check — 200 with no chain read, even with no RPC configured", async () => {
  const res = await fetch(`${baseUrl}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("GET /api/tokens/:address falls back to an older stored report, marked stale, when the live read fails", async () => {
  const T = "0x00000000000000000000000000000000000000c2";
  saveReport(T, { token: { address: T, symbol: "OLD" }, whyIsItMoving: { bullets: [], risks: [], insufficientData: true } }, Math.floor(Date.now() / 1000) - 3600);
  const res = await fetch(`${baseUrl}/api/tokens/${T}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.stale, true);
  assert.equal(body.token.symbol, "OLD");
});

test("GET /api/tokens hides DEAD launches from the feed and says how many", async () => {
  for (let i = 0; i < 6; i++) saveReport(`0x${(0xe0 + i).toString(16).padStart(40, "0")}`, { token: { symbol: `L${i}` }, fletchScore: { overall: 50 }, risk: { level: "LOW" }, signals: [] });
  saveReport(`0x${(0xef).toString(16).padStart(40, "0")}`, { token: { symbol: "DEADCAT" }, fletchScore: { overall: 99 }, risk: { level: "HIGH" }, signals: [], status: "DEAD" });
  const body = await (await fetch(`${baseUrl}/api/tokens`)).json();
  assert.equal(body.tokens.some((t: { symbol: string }) => t.symbol === "DEADCAT"), false);
  assert.ok(body.deadHidden >= 1);
});


test("GET /api/search: empty query, text query and full address — answered from stored data, no chain call", async () => {
  let r = await fetch(`${baseUrl}/api/search`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { query: "", kind: "empty", results: [] });

  r = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent("$wals")}`);
  let b = await r.json();
  assert.equal(b.kind, "text");
  assert.deepEqual(b.results, []);

  const addr = "0x" + "ab".repeat(20);
  r = await fetch(`${baseUrl}/api/search?q=${addr}`);
  b = await r.json();
  assert.equal(b.kind, "address");
  assert.equal(b.isToken, false, "an address FLETCH has never seen as a token → the client treats it as a wallet");
});


test("GET /api/wallets: empty database gives an honest empty leaderboard with its window", async () => {
  const r = await fetch(`${baseUrl}/api/wallets?hours=1&sort=buyers`);
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.hours, 1);
  assert.equal(b.sort, "buyers");
  assert.equal(b.windowBlocks, 14_000);
  assert.equal(b.latestBlock, null);
  assert.deepEqual(b.wallets, []);
  const bad = await (await fetch(`${baseUrl}/api/wallets?sort=nonsense&hours=-5`)).json();
  assert.equal(bad.sort, "active");
  assert.equal(bad.hours, 24);
});
