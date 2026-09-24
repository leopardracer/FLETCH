import { test } from "node:test";
import assert from "node:assert/strict";
import { RpcBackoff, isRpcRateLimitError, isDailyQuotaError } from "./rpcBackoff.js";

// Shapes taken from the real failure seen in live use (viem HttpRequestError
// wrapping QuickNode's responses) — status and text nested under `cause`.
const http429 = Object.assign(new Error("HTTP request failed."), {
  shortMessage: "HTTP request failed.",
  details: "Too Many Requests",
  status: 429,
});
const dailyQuota = Object.assign(new Error("Transaction creation failed."), {
  details: "daily request limit reached - upgrade your account at https://dashboard.quicknode.com/billing/plan",
});
const nested429 = Object.assign(new Error("outer"), { cause: { cause: { status: 429, message: "inner" } } });

test("a real HTTP 429 from the provider is recognized as a rate limit", () => {
  assert.equal(isRpcRateLimitError(http429), true);
  assert.equal(isDailyQuotaError(http429), false);
});

test("QuickNode's 'daily request limit reached' is recognized as a rate limit AND a daily quota", () => {
  assert.equal(isRpcRateLimitError(dailyQuota), true);
  assert.equal(isDailyQuotaError(dailyQuota), true);
});

test("a 429 buried in the cause chain is still found", () => {
  assert.equal(isRpcRateLimitError(nested429), true);
});

test("ordinary per-token failures are NOT treated as rate limits", () => {
  assert.equal(isRpcRateLimitError(new Error("execution reverted")), false);
  assert.equal(isRpcRateLimitError(new Error("Invalid address")), false);
  assert.equal(isRpcRateLimitError(Object.assign(new Error("HTTP request failed."), { status: 500 })), false);
  assert.equal(isRpcRateLimitError(null), false);
});

test("backoff starts at the base window and doubles on each consecutive rate limit, capped at max", () => {
  const b = new RpcBackoff(60, 300);
  assert.equal(b.recordRateLimit(1000, http429), true);
  assert.equal(b.resumeAt, 1060);
  assert.equal(b.recordRateLimit(1060, http429), true);
  assert.equal(b.resumeAt, 1060 + 120);
  assert.equal(b.recordRateLimit(1180, http429), true);
  assert.equal(b.resumeAt, 1180 + 240);
  assert.equal(b.recordRateLimit(1420, http429), true);
  assert.equal(b.resumeAt, 1420 + 300); // capped
});

test("a daily-quota error goes straight to the max window — retrying in a minute can't help", () => {
  const b = new RpcBackoff(60, 3600);
  b.recordRateLimit(1000, dailyQuota);
  assert.equal(b.resumeAt, 4600);
  assert.equal(b.state(1000).lastReason, "provider daily request quota reached");
});

test("several in-flight requests hitting the same limit open ONE pause, not five", () => {
  const b = new RpcBackoff(60, 3600);
  assert.equal(b.recordRateLimit(1000, http429), true);
  for (let i = 0; i < 4; i++) assert.equal(b.recordRateLimit(1000, http429), false);
  assert.equal(b.state(1000).consecutiveRateLimits, 1);
  assert.equal(b.resumeAt, 1060);
});

test("a successful read resets everything", () => {
  const b = new RpcBackoff(60, 3600);
  b.recordRateLimit(1000, http429);
  b.recordSuccess();
  assert.equal(b.isPaused(1001), false);
  assert.deepEqual(b.state(1001), { paused: false, resumeAt: null, consecutiveRateLimits: 0, lastReason: null });
});

test("the pause ends on its own at resumeAt", () => {
  const b = new RpcBackoff(60, 3600);
  b.recordRateLimit(1000, http429);
  assert.equal(b.isPaused(1059), true);
  assert.equal(b.isPaused(1060), false);
});


// Shape seen live from https://rpc.mainnet.chain.robinhood.com under load.
const http403 = Object.assign(new Error("HTTP request failed."), {
  shortMessage: "HTTP request failed.",
  details: "Forbidden",
  status: 403,
});
const http403TextOnly = new Error(
  'HTTP request failed.\n\nStatus: 403\nURL: https://rpc.mainnet.chain.robinhood.com/\nRequest body: {"method":"eth_getLogs"}'
);

test("the public RPC's HTTP 403 under load is a rate limit — pause, don't blame the token", () => {
  assert.equal(isRpcRateLimitError(http403), true);
  assert.equal(isRpcRateLimitError(Object.assign(new Error("outer"), { cause: http403 })), true);
  assert.equal(isRpcRateLimitError(http403TextOnly), true, "only the message survived (as stored in last_error)");
  assert.equal(isDailyQuotaError(http403), false, "a 403 backs off normally, not straight to the daily maximum");
});

test("a 403 pauses the breaker like a 429 does", () => {
  const b = new RpcBackoff(30, 600);
  assert.equal(b.recordRateLimit(1000, http403), true);
  assert.equal(b.isPaused(1001), true);
});
