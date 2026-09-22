import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { rephraseSummary } from "./rephrase.js";
import type { WhyIsItMoving } from "./explain.js";

const WHY: WhyIsItMoving = {
  bullets: ["Buy activity is outweighing sell activity. (12 buys vs 3 sells)"],
  risks: ["[LOW] no elevated risk findings"],
  insufficientData: false,
};

function fakeClient(reply: string | null, opts?: { throws?: boolean }): Anthropic {
  return {
    messages: {
      create: async () => {
        if (opts?.throws) throw new Error("simulated network failure");
        return { content: reply === null ? [] : [{ type: "text", text: reply }] };
      },
    },
  } as unknown as Anthropic;
}

test("with no client configured (no API key), falls back to the deterministic bullets joined — never throws", async () => {
  const result = await rephraseSummary(WHY, null);
  assert.equal(result.source, "DETERMINISTIC_FALLBACK");
  assert.equal(result.text, `${WHY.bullets[0]} ${WHY.risks[0]}`);
});

test("with a working client, returns the model's rephrased text and tags it as LLM-sourced", async () => {
  const client = fakeClient("Buying is outpacing selling right now, and nothing elevated has been flagged.");
  const result = await rephraseSummary(WHY, client);
  assert.equal(result.source, "LLM");
  assert.equal(result.text, "Buying is outpacing selling right now, and nothing elevated has been flagged.");
});

test("if the API call throws, falls back to the deterministic text instead of propagating the error", async () => {
  const client = fakeClient(null, { throws: true });
  const result = await rephraseSummary(WHY, client);
  assert.equal(result.source, "DETERMINISTIC_FALLBACK");
});

test("if the model returns no text block (or empty text), falls back rather than returning blank", async () => {
  const client = fakeClient(null);
  const result = await rephraseSummary(WHY, client);
  assert.equal(result.source, "DETERMINISTIC_FALLBACK");
  assert.ok(result.text.length > 0);
});

test("the fallback path never depends on the client at all — a null client and an empty-response client agree", async () => {
  const a = await rephraseSummary(WHY, null);
  const b = await rephraseSummary(WHY, fakeClient(null));
  assert.equal(a.text, b.text);
});
