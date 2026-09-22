import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { runChatAgent, type AgentDeps } from "./chatAgent.js";
import type { TokenInfo } from "../chain/token.js";
import type { TokenIntel } from "../intel/tokenIntel.js";
import type { WalletIntelligence } from "../wallets/walletScore.js";
import type { RadarEntry } from "../radar/radarService.js";
import type { RpcChainDataProvider } from "../data/providers/rpcProvider.js";

const TOKEN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;

function fakeDeps(overrides: Partial<AgentDeps> = {}): AgentDeps {
  return {
    readTokenInfo: async (address) =>
      ({ address, symbol: "MOONCAT", name: "Mooncat", decimals: 18, totalSupply: 1000n, contractExists: true }) as TokenInfo,
    getTokenIntel: async () =>
      ({
        token: { address: TOKEN, symbol: "MOONCAT", name: "Mooncat", contractExists: true },
        risk: { level: "LOW", findings: [], safetyScore: 100 },
        fletchScore: { overall: 70 },
        signals: [],
        whyIsItMoving: { bullets: ["Buy pressure detected."], risks: ["[LOW] no elevated risk findings"], insufficientData: false },
        smartMoney: { available: false, reason: "not tracked yet" },
        social: { available: false, reason: "not tracked yet" },
        dataAvailability: {
          liquidity: "REAL",
          holders: "REAL",
          whaleActivity: "REAL",
          smartMoney: "NOT_YET_IMPLEMENTED",
          social: "NOT_YET_IMPLEMENTED",
          postGraduationPricing: "NOT_YET_IMPLEMENTED",
          blockscoutAcceleration: "REQUIRES_API_KEY",
        },
      }) as unknown as TokenIntel,
    getWalletIntelligence: () =>
      ({
        wallet: "0xccc...",
        profile: null,
        metrics: {
          winRate: { availability: "NOT_YET_IMPLEMENTED" },
          earlyEntryTiming: { availability: "NOT_YET_IMPLEMENTED" },
          realizedPnl: { availability: "NOT_YET_IMPLEMENTED" },
          unrealizedPnl: { availability: "NOT_YET_IMPLEMENTED" },
          averageHoldingPeriod: { availability: "NOT_YET_IMPLEMENTED" },
          accumulationBehavior: { availability: "NOT_YET_IMPLEMENTED" },
        },
      }) as WalletIntelligence,
    getRadar: async () => [] as RadarEntry[],
    provider: {} as RpcChainDataProvider,
    ...overrides,
  };
}

/** Scripts a sequence of client.messages.create() responses, one per call, and records every call's params for inspection. */
function scriptedClient(responses: Anthropic.Message[], calls: unknown[] = []): Anthropic {
  let i = 0;
  return {
    messages: {
      create: async (params: unknown) => {
        calls.push(params);
        const r = responses[Math.min(i, responses.length - 1)];
        i++;
        return r;
      },
    },
  } as unknown as Anthropic;
}

function textMessage(text: string): Anthropic.Message {
  return { content: [{ type: "text", text }] } as unknown as Anthropic.Message;
}

function toolUseMessage(id: string, name: string, input: Record<string, unknown>): Anthropic.Message {
  return { content: [{ type: "tool_use", id, name, input }] } as unknown as Anthropic.Message;
}

test("with no client configured, returns the disabled message and makes zero tool calls", async () => {
  const result = await runChatAgent([{ role: "user", content: "hi" }], fakeDeps(), null);
  assert.match(result.reply, /ANTHROPIC_API_KEY/);
  assert.equal(result.toolCalls.length, 0);
});

test("a plain-text reply with no tool use returns immediately, no tools called", async () => {
  const client = scriptedClient([textMessage("Hi! Ask me about any token or wallet on Robinhood Chain.")]);
  const result = await runChatAgent([{ role: "user", content: "hello" }], fakeDeps(), client);
  assert.equal(result.reply, "Hi! Ask me about any token or wallet on Robinhood Chain.");
  assert.equal(result.toolCalls.length, 0);
});

test("get_token_report: calls the tool, logs it, and returns the model's follow-up text", async () => {
  const client = scriptedClient([
    toolUseMessage("t1", "get_token_report", { address: TOKEN }),
    textMessage("FLETCH flagged buy pressure on MOONCAT, with a LOW risk level."),
  ]);
  const result = await runChatAgent([{ role: "user", content: `what about ${TOKEN}?` }], fakeDeps(), client);
  assert.equal(result.reply, "FLETCH flagged buy pressure on MOONCAT, with a LOW risk level.");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "get_token_report");
});

test("get_token_report with an invalid address never reaches readTokenInfo — the executor rejects it first", async () => {
  let called = false;
  const deps = fakeDeps({ readTokenInfo: async () => { called = true; throw new Error("should not be called"); } });
  const client = scriptedClient([
    toolUseMessage("t1", "get_token_report", { address: "not-an-address" }),
    textMessage("That doesn't look like a valid Robinhood Chain address — could you share the 0x address?"),
  ]);
  const result = await runChatAgent([{ role: "user", content: "check 'not-an-address'" }], deps, client);
  assert.equal(called, false);
  assert.match(result.reply, /valid/);
});

test("get_wallet_report calls getWalletIntelligence with a lowercased address", async () => {
  let seen: string | null = null;
  const deps = fakeDeps({
    getWalletIntelligence: (address) => {
      seen = address;
      return { wallet: address, profile: null, metrics: {} } as unknown as WalletIntelligence;
    },
  });
  const client = scriptedClient([
    toolUseMessage("t1", "get_wallet_report", { address: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" }),
    textMessage("Here's what FLETCH has on that wallet."),
  ]);
  await runChatAgent([{ role: "user", content: "check that wallet" }], deps, client);
  assert.equal(seen, "0xcccccccccccccccccccccccccccccccccccccccc");
});

test("get_radar caps the limit at 25 regardless of what the model asks for", async () => {
  const manyEntries = Array.from({ length: 40 }, (_, i) => ({ token: `0x${i}` })) as unknown as RadarEntry[];
  const deps = fakeDeps({ getRadar: async () => manyEntries });
  const calls: unknown[] = [];
  const client = scriptedClient(
    [toolUseMessage("t1", "get_radar", { limit: 999 }), textMessage("Here's the current radar.")],
    calls
  );
  await runChatAgent([{ role: "user", content: "show me the radar" }], deps, client);

  // Second create() call carries the tool_result the executor produced —
  // inspect it directly rather than trusting the loop merely didn't throw.
  const secondCallMessages = (calls[1] as { messages: Array<{ content: unknown }> }).messages;
  const toolResultMsg = secondCallMessages[secondCallMessages.length - 1];
  const toolResultContent = (toolResultMsg.content as Array<{ content: string }>)[0].content;
  const radarPayload = JSON.parse(toolResultContent) as unknown[];
  assert.equal(radarPayload.length, 25);
});

test("stops after maxTurns and returns the graceful giving-up message instead of looping forever", async () => {
  const client = scriptedClient([toolUseMessage("t1", "get_radar", {})]); // always returns tool_use — scriptedClient repeats the last one
  const result = await runChatAgent([{ role: "user", content: "loop forever" }], fakeDeps(), client, 3);
  assert.equal(result.toolCalls.length, 3);
  assert.match(result.reply, /one token or wallet at a time/);
});

test("unknown tool name from the model is handled without throwing", async () => {
  const client = scriptedClient([
    toolUseMessage("t1", "delete_everything", {}),
    textMessage("I don't have a tool for that."),
  ]);
  const result = await runChatAgent([{ role: "user", content: "do something weird" }], fakeDeps(), client);
  assert.equal(result.reply, "I don't have a tool for that.");
});
