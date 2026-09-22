import Anthropic from "@anthropic-ai/sdk";
import { config } from "../core/config.js";

let cached: Anthropic | null | undefined;

/**
 * Returns a configured Anthropic client, or `null` when ANTHROPIC_API_KEY
 * isn't set. Every caller in src/ai/ must treat `null` as "feature
 * disabled" and fall back to non-AI behavior (see explain.ts's comment
 * on the safe rephrase pattern, rephrase.ts, chatAgent.ts) — never throw
 * just because the key is missing, and never call the real API from a
 * unit test (pass a fake client in instead; see rephrase.test.ts /
 * chatAgent.test.ts for the pattern).
 */
export function getAnthropicClient(): Anthropic | null {
  if (cached !== undefined) return cached;
  cached = config.hasAnthropic() ? new Anthropic({ apiKey: config.anthropicApiKey }) : null;
  return cached;
}

/** Test-only: clears the cached client so config changes take effect. */
export function _resetAnthropicClientCache(): void {
  cached = undefined;
}
