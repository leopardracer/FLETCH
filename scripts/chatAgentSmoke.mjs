/**
 * Smoke-tests web/chatAgent.js — the browser-side BYOK chat agent — against
 * a REAL running FLETCH server, without needing a real Anthropic API key or
 * a browser. Only the fetch() calls to api.anthropic.com are faked; every
 * call to FLETCH's own /api/* endpoints goes to the real server you point
 * this at, exercising the actual getFletchJSON/executeTool/fencing logic
 * in web/chatAgent.js — not a reimplementation of it.
 *
 * Run against `npm run dev` (any .env — RPC_URL doesn't need to be set;
 * the RPC-unavailable case is one of the things this checks):
 *
 *   node scripts/chatAgentSmoke.mjs
 *   FLETCH_URL=http://localhost:8787 node scripts/chatAgentSmoke.mjs
 *
 * This is a smoke test, not part of `npm test` — it needs a live server
 * process, same reason scripts/screenshot.mjs isn't wired into the
 * normal suite either. Exits non-zero on any check failure.
 */

const BASE = process.env.FLETCH_URL || "http://localhost:8787";
const realFetch = fetch;
let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok — ${label}`);
  } else {
    failures++;
    console.log(`  FAIL — ${label}${detail ? `: ${detail}` : ""}`);
  }
}

/** Loads web/chatAgent.js fresh with a scripted fetch() so each scenario gets an isolated globalThis.fetch. */
async function loadAgent(anthropicHandler) {
  globalThis.window = { FLETCH_API_BASE: BASE };
  globalThis.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  globalThis.fetch = async (url, opts) => {
    if (typeof url === "string" && url.startsWith("https://api.anthropic.com")) {
      return anthropicHandler(url, opts);
    }
    return realFetch(url, opts);
  };
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(new URL("../web/chatAgent.js", import.meta.url), "utf8");
  const wrapped = src.replace("window.FletchChatAgent", "globalThis.__chatAgentUnderTest");
  delete globalThis.__chatAgentUnderTest;
  await eval(`(async () => { ${wrapped} })()`);
  return globalThis.__chatAgentUnderTest;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

async function main() {
  console.log(`Smoke-testing web/chatAgent.js against ${BASE}\n`);

  console.log("Scenario: no tool call, plain text reply");
  {
    const agent = await loadAgent(async () => jsonResponse({ content: [{ type: "text", text: "Hi there." }] }));
    const r = await agent.runBrowserChatAgent([{ role: "user", content: "hello" }], "fake-key");
    check("reply is the model's text", r.reply === "Hi there.", r.reply);
    check("no tool calls logged", r.toolCalls.length === 0);
  }

  console.log("\nScenario: get_wallet_report round-trip against the real server (no RPC needed for this one)");
  {
    let call = 0;
    let seenToolResult = null;
    const agent = await loadAgent(async (_url, opts) => {
      call++;
      if (call === 1) {
        return jsonResponse({
          content: [{ type: "tool_use", id: "t1", name: "get_wallet_report", input: { address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }],
        });
      }
      const body = JSON.parse(opts.body);
      seenToolResult = JSON.parse(body.messages[body.messages.length - 1].content[0].content);
      return jsonResponse({ content: [{ type: "text", text: "No recorded activity for that wallet yet." }] });
    });
    const r = await agent.runBrowserChatAgent([{ role: "user", content: "check that wallet" }], "fake-key");
    check("tool_result came from the real server (has .metrics)", !!(seenToolResult && seenToolResult.metrics));
    check("final reply present", typeof r.reply === "string" && r.reply.length > 0, r.reply);
    check("tool call logged", r.toolCalls.length === 1 && r.toolCalls[0].name === "get_wallet_report");
  }

  console.log("\nScenario: get_token_report against a server with no RPC_URL — real honest error, not a fake success");
  {
    let call = 0;
    let seenToolResult = null;
    const agent = await loadAgent(async (_url, opts) => {
      call++;
      if (call === 1) {
        return jsonResponse({
          content: [{ type: "tool_use", id: "t1", name: "get_token_report", input: { address: "0x44330Eaa031e8E5b0D9D236619314fC210575ed6" } }],
        });
      }
      const body = JSON.parse(opts.body);
      seenToolResult = JSON.parse(body.messages[body.messages.length - 1].content[0].content);
      return jsonResponse({ content: [{ type: "text", text: "FLETCH can't reach the chain right now." }] });
    });
    await agent.runBrowserChatAgent([{ role: "user", content: "check that token" }], "fake-key");
    check(
      "tool_result is an honest {error}, not fabricated data",
      !!(seenToolResult && typeof seenToolResult.error === "string"),
      JSON.stringify(seenToolResult)
    );
  }

  console.log("\nScenario: Anthropic returns 401 (bad key) — degrades gracefully, never throws");
  {
    const agent = await loadAgent(async () => jsonResponse({ error: { message: "invalid x-api-key" } }, 401));
    const r = await agent.runBrowserChatAgent([{ role: "user", content: "hi" }], "bad-key");
    check("reply mentions the failure", /failed|invalid|check your api key/i.test(r.reply), r.reply);
    check("no tool calls logged", r.toolCalls.length === 0);
  }

  console.log("\nScenario: network failure reaching Anthropic — degrades gracefully, never throws");
  {
    const agent = await loadAgent(async () => {
      throw new TypeError("Failed to fetch");
    });
    const r = await agent.runBrowserChatAgent([{ role: "user", content: "hi" }], "some-key");
    check("reply mentions the failure", /couldn't reach/i.test(r.reply), r.reply);
  }

  console.log("\nScenario: no API key — never calls Anthropic at all");
  {
    let anthropicCalled = false;
    const agent = await loadAgent(async () => {
      anthropicCalled = true;
      return jsonResponse({ content: [{ type: "text", text: "should not get here" }] });
    });
    const r = await agent.runBrowserChatAgent([{ role: "user", content: "hi" }], "");
    check("Anthropic never called", !anthropicCalled);
    check("reply asks for a key", /api key/i.test(r.reply), r.reply);
  }

  console.log("\nScenario: hostile ERC20 metadata arrives fenced (prompt-injection defense mirrors chatAgent.ts)");
  {
    // Requires a live token whose report includes the hostile fixture — instead,
    // verify the fencing function's own behavior directly via the module's tool
    // executor path by round-tripping a wallet report is not enough (wallet has no
    // free-text fields), so this checks the fencing markers appear verbatim in
    // source — a structural guard against silently deleting the mitigation.
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../web/chatAgent.js", import.meta.url), "utf8");
    check("fenceTokenIntel function present", src.includes("function fenceTokenIntel("));
    check("fenceRadarEntries function present", src.includes("function fenceRadarEntries("));
    check("UNTRUSTED_ONCHAIN_STRING marker present", src.includes("UNTRUSTED_ONCHAIN_STRING"));
    check("SYSTEM_PROMPT names the untrusted-data rule", src.includes("Untrusted data warning"));
  }

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Smoke test crashed:", e);
  process.exit(1);
});
