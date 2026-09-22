# AI layer

`src/ai/client.ts` (client) + `src/ai/rephrase.ts` (natural-language summaries) + `src/ai/chatAgent.ts` (chat agent) + `GET /api/tokens/:address?summary=ai` + `POST /api/chat`.

Entirely optional. Unset `ANTHROPIC_API_KEY` and every AI feature degrades cleanly instead of throwing — see "Off by default" below.

## What it answers

FLETCH's core promise is deterministic, evidence-based signals with zero fabricated data — see the project README. The AI layer doesn't change that promise; it adds two things **on top of** the same deterministic output, never in place of it:

| | What it does | What it never does |
|---|---|---|
| **Natural-language summary** | Rephrases the bullets `explainWhyItsMoving()` already computed into one readable paragraph | Add a number, name, or claim that wasn't already in those bullets |
| **Chat agent** | Answers questions about a token/wallet by calling FLETCH's real functions as tools and reporting back what they returned | State a fact, price, or risk level that didn't come from a tool result in that same conversation |

Both are **rephrase/report** patterns, not **generate** patterns — the model never sees raw chain data and is never asked to reason from first principles about whether a token is good or bad. It restates numbers FLETCH already computed, or fetches them live via tools and restates those.

## Off by default

`ANTHROPIC_API_KEY` unset (the default) means:

- `getAnthropicClient()` (`src/ai/client.ts`) returns `null`.
- `GET /api/tokens/:address?summary=ai` simply omits `naturalLanguageSummary` from the response — the rest of the response is identical to the endpoint without `?summary=ai`, and identical to before this feature existed.
- `POST /api/chat` replies with a plain `"AI chat isn't configured on this FLETCH instance — set ANTHROPIC_API_KEY to enable it."` and calls zero tools.

Nothing throws, nothing silently returns an empty/fake result. This is the same "honest `UNAVAILABLE` instead of a guess" pattern the rest of FLETCH uses for `smartMoney`, `social`, and unset `BLOCKSCOUT_API_KEY`.

## Natural-language summary

`rephraseSummary(why, client?)` — `src/ai/rephrase.ts`.

1. Takes the `WhyIsItMoving` object `explainWhyItsMoving()` already built from real `Signal[]` (see [SIGNALS.md](./SIGNALS.md)) — a list of bullet strings, nothing else.
2. Sends **only that list** to the model, with a system prompt that explicitly forbids adding any fact, number, or prediction not already in it, and requires it to say plainly when the list itself says data is unavailable.
3. Returns `{ text, source }` where `source` is `"LLM"` (the model's rephrase) or `"DETERMINISTIC_FALLBACK"` (no client configured, the call failed, or the model returned empty text — `text` is then just the bullets joined as-is). Callers should show `source`, not hide it — a fallback presented as if it were the AI summary would misrepresent what actually happened.

Reachable via `GET /api/tokens/:address?summary=ai`. Opt-in and omitted by default so a normal page view never pays the extra LLM latency or cost — the deterministic `whyIsItMoving` field is always present regardless.

## Chat agent

`runChatAgent(messages, deps?, client?, maxTurns?)` — `src/ai/chatAgent.ts`. Reachable via `POST /api/chat`.

```json
// Request
{ "messages": [{ "role": "user", "content": "what's going on with 0xabc...?" }] }

// Response
{ "reply": "FLETCH flagged buy pressure on MOONCAT, with a LOW risk level.", "toolCalls": [{ "name": "get_token_report", "input": { "address": "0xabc..." } }] }
```

`messages`: 1–20 turns, `role` `"user"` or `"assistant"`, `content` up to 4000 characters (`chatRequestSchema` in `api/server.ts`).

### Tools

Three tools, each a thin wrapper around a function the rest of FLETCH already uses — no tool computes anything new:

| Tool | Backed by | Same code path as |
|---|---|---|
| `get_token_report` | `getTokenIntel()` (`src/intel/tokenIntel.ts`) | `GET /api/tokens/:address` |
| `get_wallet_report` | `getWalletIntelligence()` | `GET /api/wallets/:address` |
| `get_radar` | `getRadar()` | `GET /api/radar` |

`get_token_report` and `GET /api/tokens/:address` call the literal same function — `src/intel/tokenIntel.ts` was extracted from the route handler specifically so the HTTP API and the chat agent can't drift into reporting different numbers for the same token. An invalid address is rejected by the tool executor itself (regex check) before it ever reaches a chain read.

### The system prompt's rules

The full prompt is `SYSTEM_PROMPT` in `chatAgent.ts`. The load-bearing rules:

- Never state a number, date, risk level, or fact about a specific token/wallet unless it came from a `tool_result` in this conversation.
- Never predict future price or performance, and never call anything "safe to buy" — FLETCH reports what already happened on-chain, not forecasts.
- A tool result marked `UNAVAILABLE`/`NOT_YET_IMPLEMENTED` must be reported as FLETCH not having that data yet — never filled in with a guess.
- No valid address given → ask for one, never guess which token is meant.

This is enforced by the system prompt, not by code — same trust boundary as any tool-use LLM integration. The code-level guarantee is narrower but harder: **the tools themselves can only return data FLETCH's deterministic engine actually computed**, so even a prompt-injection or a model that ignores instructions has no fabricated data available to draw from — at worst it can only misrepresent or omit real tool output, not invent new numbers from nothing.

### The loop

Up to `maxTurns` (default 4) round-trips: send the conversation, execute any `tool_use` blocks against the real functions above, feed `tool_result`s back, repeat until the model replies in plain text. Hitting `maxTurns` without a plain-text reply returns a graceful "try one token/wallet at a time" message rather than looping forever or timing out silently.

## Testing

`src/ai/rephrase.test.ts` and `src/ai/chatAgent.test.ts` inject a fake Anthropic client (and, for the agent, fake `AgentDeps`) — no real network call, no `ANTHROPIC_API_KEY` needed to run the suite. Same isolation principle `api/server.test.ts` already uses for `RPC_URL`.

## Not built in this pass

- **Streaming.** `POST /api/chat` returns the full reply in one response; no SSE/streaming endpoint yet.
- **Conversation persistence.** Each request carries its own full `messages` history from the caller — nothing is stored server-side between requests.
- **Rate limiting specific to chat.** `/api/chat` sits under the same `/api/*` limiter as everything else (`RATE_LIMIT_WINDOW_MS`/`RATE_LIMIT_MAX`), not a separate, tool-use-aware budget — a single chat conversation with several tool-calling turns counts as several requests against that shared limit.
- **Tools beyond the three above** (e.g. `get_signals`, `get_snapshot_history`) — straightforward to add following the same pattern (wrap an existing real function, validate input, never compute anything new) if a real use case needs them.
