import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../core/config.js";
import { getAnthropicClient } from "./client.js";
import { readTokenInfo, type TokenInfo } from "../chain/token.js";
import { RpcChainDataProvider } from "../data/providers/rpcProvider.js";
import { getTokenIntel, type TokenIntel } from "../intel/tokenIntel.js";
import { getWalletIntelligence, type WalletIntelligence } from "../wallets/walletScore.js";
import { getRadar, type RadarEntry } from "../radar/radarService.js";
import { RADAR_WINDOW_SECONDS_DEFAULT } from "../radar/radarEngine.js";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * Everything the agent is allowed to call, injectable so tests never hit
 * a real RPC or the real Anthropic API (see chatAgent.test.ts). The
 * default export wires the real functions — same code paths the HTTP API
 * uses (get_token_report reuses src/intel/tokenIntel.ts, the exact
 * function GET /api/tokens/:address calls).
 */
export interface AgentDeps {
  readTokenInfo(address: `0x${string}`): Promise<TokenInfo>;
  getTokenIntel(address: `0x${string}`, info: TokenInfo, provider: RpcChainDataProvider): Promise<TokenIntel>;
  getWalletIntelligence(address: `0x${string}`): WalletIntelligence;
  getRadar(windowSeconds?: number): Promise<RadarEntry[]>;
  provider: RpcChainDataProvider;
}

export function createDefaultAgentDeps(): AgentDeps {
  return {
    readTokenInfo,
    getTokenIntel,
    getWalletIntelligence,
    getRadar,
    provider: new RpcChainDataProvider(),
  };
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_token_report",
    description:
      "FLETCH's real-time on-chain report for one token on Robinhood Chain: risk findings, FLETCH Score, " +
      "detected signals, and a plain-language explanation of why it's moving. Any field FLETCH can't currently " +
      "observe comes back as UNAVAILABLE or NOT_YET_IMPLEMENTED — never guess a value for those.",
    input_schema: {
      type: "object",
      properties: { address: { type: "string", description: "0x-prefixed token contract address, 40 hex characters." } },
      required: ["address"],
    },
  },
  {
    name: "get_wallet_report",
    description: "FLETCH's on-chain participation record for one wallet address on Robinhood Chain.",
    input_schema: {
      type: "object",
      properties: { address: { type: "string", description: "0x-prefixed wallet address, 40 hex characters." } },
      required: ["address"],
    },
  },
  {
    name: "get_radar",
    description:
      "FLETCH's Meme Radar — tokens with the strongest recent on-chain signal activity right now, ranked by " +
      "recency-weighted signal convergence (not by size or FLETCH Score).",
    input_schema: {
      type: "object",
      properties: {
        windowSeconds: { type: "number", description: `Lookback window in seconds. Defaults to ${RADAR_WINDOW_SECONDS_DEFAULT}.` },
        limit: { type: "number", description: "Max entries to return, capped at 25." },
      },
    },
  },
];

export const SYSTEM_PROMPT = `
You are FLETCH's on-chain assistant for Robinhood Chain. You help people understand tokens and wallets using ONLY the data returned by your tools in this conversation — never your own knowledge, memory, or a guess about any specific token, wallet, or price.

Rules, no exceptions:
- Never state a number, date, risk level, or fact about a specific token or wallet unless it came from a tool_result in this conversation.
- Never predict future price or performance, and never call anything "safe to buy" — FLETCH reports what has already happened on-chain, not forecasts.
- If a tool_result marks a field UNAVAILABLE or NOT_YET_IMPLEMENTED, say plainly that FLETCH doesn't have that data yet — never fill the gap with a guess.
- If the person hasn't given a valid contract or wallet address, ask for one rather than guessing which token they mean.
- Attribute findings to FLETCH ("FLETCH flagged...", "FLETCH's signal engine detected...") and keep answers concise.
- General conversation (greetings, explaining what FLETCH is, what a term means) doesn't need a tool call.
`.trim();

async function executeTool(name: string, input: Record<string, unknown>, deps: AgentDeps): Promise<unknown> {
  switch (name) {
    case "get_token_report": {
      const raw = String(input.address ?? "");
      if (!ADDRESS_RE.test(raw)) return { error: `"${raw}" isn't a valid Robinhood Chain address (expected 0x + 40 hex chars).` };
      const address = raw.toLowerCase() as `0x${string}`;
      const info = await deps.readTokenInfo(address).catch(() => null);
      if (!info || !info.contractExists) return { error: `No contract found at ${address} on Robinhood Chain.` };
      return deps.getTokenIntel(address, info, deps.provider);
    }
    case "get_wallet_report": {
      const raw = String(input.address ?? "");
      if (!ADDRESS_RE.test(raw)) return { error: `"${raw}" isn't a valid Robinhood Chain address (expected 0x + 40 hex chars).` };
      return deps.getWalletIntelligence(raw.toLowerCase() as `0x${string}`);
    }
    case "get_radar": {
      const windowSeconds = typeof input.windowSeconds === "number" ? input.windowSeconds : undefined;
      const limit = typeof input.limit === "number" ? Math.max(1, Math.min(25, input.limit)) : 15;
      const radar = await deps.getRadar(windowSeconds);
      return radar.slice(0, limit);
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

/** Bigints (e.g. TokenMetrics fields) can't cross JSON.stringify on their own — this keeps a tool_result from throwing on one. */
function toolResultJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

export interface ChatAgentResult {
  reply: string;
  toolCalls: Array<{ name: string; input: unknown }>;
}

/**
 * Runs the tool-use loop: sends the conversation to Claude, executes any
 * tool_use blocks against the real FLETCH functions (never fabricated),
 * feeds the results back, and repeats until Claude answers in plain text
 * or `maxTurns` is hit. See SYSTEM_PROMPT for the no-fabrication rules
 * this depends on the model following.
 */
export async function runChatAgent(
  messages: Anthropic.MessageParam[],
  deps: AgentDeps = createDefaultAgentDeps(),
  client: Anthropic | null = getAnthropicClient(),
  maxTurns = 4
): Promise<ChatAgentResult> {
  if (!client) {
    return {
      reply: "AI chat isn't configured on this FLETCH instance — set ANTHROPIC_API_KEY to enable it.",
      toolCalls: [],
    };
  }

  const conversation: Anthropic.MessageParam[] = [...messages];
  const toolCallLog: Array<{ name: string; input: unknown }> = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    let res: Anthropic.Message;
    try {
      res = await client.messages.create({
        model: config.anthropicModel,
        max_tokens: 700,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: conversation,
      });
    } catch {
      // Bad/expired key, rate limit, or a transient Anthropic-side issue —
      // never leak the SDK's raw error (or a bare 500) to the caller; same
      // "degrade, don't throw" rule rephrase.ts follows for this exact
      // class of failure. Any tool calls already made this turn are still
      // reported back via toolCallLog.
      return {
        reply: "The AI chat service isn't reachable right now — check ANTHROPIC_API_KEY and try again shortly.",
        toolCalls: toolCallLog,
      };
    }

    const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

    if (toolUses.length === 0) {
      const textBlock = res.content.find((b): b is Anthropic.TextBlock => b.type === "text");
      return { reply: textBlock?.text.trim() ?? "", toolCalls: toolCallLog };
    }

    conversation.push({ role: "assistant", content: res.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      toolCallLog.push({ name: use.name, input: use.input });
      const result = await executeTool(use.name, (use.input ?? {}) as Record<string, unknown>, deps);
      toolResults.push({ type: "tool_result", tool_use_id: use.id, content: toolResultJson(result) });
    }
    conversation.push({ role: "user", content: toolResults });
  }

  return {
    reply: "That's taking more lookups than I can finish in one go — try asking about one token or wallet at a time.",
    toolCalls: toolCallLog,
  };
}
