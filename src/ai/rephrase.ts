import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../core/config.js";
import { getAnthropicClient } from "./client.js";
import type { WhyIsItMoving } from "./explain.js";

export interface NaturalLanguageSummary {
  text: string;
  /** LLM: the model rephrased it. DETERMINISTIC_FALLBACK: no key
   *  configured, or the call failed/returned nothing — `text` is the
   *  deterministic bullets joined as-is, not AI-generated. The caller
   *  (API response, chat agent) should surface which one this is rather
   *  than presenting a fallback as if it were the AI summary. */
  source: "LLM" | "DETERMINISTIC_FALLBACK";
}

const SYSTEM_PROMPT = `
You rewrite a fixed list of facts into one short, plain-English paragraph (2–4 sentences).

Rules, no exceptions:
- Use ONLY the facts in the list below. Never add a number, name, cause, or claim that isn't already there.
- Never predict price or future performance, and never say anything is "safe" or "risky to buy" beyond restating the given risk level.
- If the list says data is unavailable or insufficient, say that plainly — never fill the gap with a guess.
- Plain prose only: no bullet points, no markdown, no headings, no preamble like "Here's a summary".
`.trim();

/**
 * Turns `explainWhyItsMoving`'s deterministic bullets/risks into one
 * readable paragraph. Deliberately a rephrase-only call — the model sees
 * ONLY the facts FLETCH's signal engine already computed (see
 * src/ai/explain.ts's own comment on this exact pattern), with a system
 * prompt that forbids adding anything. If no client is configured, or
 * the call fails or returns empty text for any reason, this falls back
 * to joining the bullets directly — the feature degrades to "no AI",
 * never to fabricated or silently missing text.
 */
export async function rephraseSummary(
  why: WhyIsItMoving,
  client: Anthropic | null = getAnthropicClient()
): Promise<NaturalLanguageSummary> {
  const fallback = (): NaturalLanguageSummary => ({
    text: [...why.bullets, ...why.risks].join(" "),
    source: "DETERMINISTIC_FALLBACK",
  });

  if (!client) return fallback();

  const facts = JSON.stringify({ movement: why.bullets, risk: why.risks });

  try {
    const res = await client.messages.create({
      model: config.anthropicModel,
      max_tokens: 220,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Facts:\n${facts}` }],
    });

    const block = res.content.find((b) => b.type === "text");
    const text = block && block.type === "text" ? block.text.trim() : "";
    return text ? { text, source: "LLM" } : fallback();
  } catch {
    // Network/API failure of any kind — never let an outage take down the
    // endpoint or silently show nothing; degrade to the deterministic text.
    return fallback();
  }
}
