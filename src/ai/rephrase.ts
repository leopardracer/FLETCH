import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../core/config.js";
import { getAnthropicClient } from "./client.js";
import type { WhyIsItMoving } from "./explain.js";

export interface NaturalLanguageSummary {
  text: string;
  /** LLM: the model rephrased it. DETERMINISTIC_FALLBACK: no key
   *  configured, or the call failed/returned nothing — `text` is the
   *  deterministic facts joined as-is, not AI-generated. The caller
   *  (API response, chat agent, dashboard) should surface which one this
   *  is rather than presenting a fallback as if it were the AI summary. */
  source: "LLM" | "DETERMINISTIC_FALLBACK";
}

const RULES = `
Rules, no exceptions:
- Use ONLY the facts in the list you're given. Never add a number, name, cause, or claim that isn't already there.
- Never predict price or future performance, and never say anything is "safe" or "risky to buy" beyond restating a given risk level.
- Never tell anyone to buy, sell, or hold anything.
- If the list says data is unavailable or insufficient, say that plainly — never fill the gap with a guess.
- Plain prose only: no bullet points, no markdown, no headings, no preamble like "Here's a summary".
`.trim();

/** What the paragraph is about — changes only the framing line of the system prompt, never the rules. */
export type RephrasePurpose = "token" | "market" | "wallet";

const FRAMING: Record<RephrasePurpose, string> = {
  token: "You rewrite a fixed list of facts about one token on Robinhood Chain into one short, plain-English paragraph (2–4 sentences).",
  market:
    "You are FLETCH's market brief. Rewrite a fixed list of facts about recent on-chain activity across Robinhood Chain into one short, plain-English paragraph (3–5 sentences) a trader can read in ten seconds.",
  wallet:
    "You rewrite a fixed list of facts about one wallet's observed trading on Robinhood Chain into one short, plain-English paragraph (2–4 sentences), describing its behavior neutrally — never as advice to copy it.",
};

export function systemPromptFor(purpose: RephrasePurpose): string {
  return `${FRAMING[purpose]}\n\n${RULES}`;
}

/**
 * Small in-process cache so a public page view never triggers an LLM call
 * for facts that were already rephrased recently. Keyed by purpose + the
 * exact facts, so any real change in the underlying data is a cache miss
 * — a cached paragraph can never describe facts that no longer hold.
 * Only LLM successes are cached; a fallback is retried next time.
 */
const CACHE_TTL_SECONDS = 600;
const CACHE_MAX_ENTRIES = 500;
const cache = new Map<string, { at: number; text: string }>();

export function _clearRephraseCacheForTests(): void {
  cache.clear();
}

/**
 * The one safe pattern every AI summary in FLETCH uses: the model sees
 * ONLY facts FLETCH's deterministic engine already computed, with a
 * system prompt forbidding it to add anything. No client, a failed call,
 * or empty text all degrade to the facts joined as-is — never to
 * fabricated or silently missing text.
 */
export async function rephraseFacts(
  facts: string[],
  purpose: RephrasePurpose,
  client: Anthropic | null = getAnthropicClient(),
  now: number = Math.floor(Date.now() / 1000)
): Promise<NaturalLanguageSummary> {
  const fallback = (): NaturalLanguageSummary => ({ text: facts.join(" "), source: "DETERMINISTIC_FALLBACK" });
  if (!client || facts.length === 0) return fallback();

  const key = `${purpose}\u0000${JSON.stringify(facts)}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_SECONDS) return { text: hit.text, source: "LLM" };

  try {
    const res = await client.messages.create({
      model: config.anthropicModel,
      max_tokens: purpose === "market" ? 320 : 220,
      system: systemPromptFor(purpose),
      messages: [{ role: "user", content: `Facts:\n${JSON.stringify(facts)}` }],
    });
    const block = res.content.find((b) => b.type === "text");
    const text = block && block.type === "text" ? block.text.trim() : "";
    if (!text) return fallback();
    if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
    cache.set(key, { at: now, text });
    return { text, source: "LLM" };
  } catch {
    // Network/API failure of any kind — never let an outage take down the
    // endpoint or silently show nothing; degrade to the deterministic text.
    return fallback();
  }
}

/**
 * Turns `explainWhyItsMoving`'s deterministic bullets/risks into one
 * readable paragraph — see rephraseFacts for the guarantees.
 */
export async function rephraseSummary(
  why: WhyIsItMoving,
  client: Anthropic | null = getAnthropicClient()
): Promise<NaturalLanguageSummary> {
  return rephraseFacts([...why.bullets, ...why.risks], "token", client);
}
