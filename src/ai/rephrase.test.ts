import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { rephraseSummary, rephraseFacts, systemPromptFor, _clearRephraseCacheForTests } from "./rephrase.js";
import type { WhyIsItMoving } from "./explain.js";

const WHY: WhyIsItMoving = {
  bullets: ["Buy activity is outweighing sell activity. (12 buys vs 3 sells)"],
  risks: ["[LOW] no elevated risk findings"],
  insufficientData: false,
};

beforeEach(() => {
  _clearRephraseCacheForTests();
});

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

function countingClient(reply: string): { client: Anthropic; calls: () => number; lastParams: () => { system: string; messages: { content: string }[] } } {
  let n = 0;
  let last: unknown;
  const client = {
    messages: {
      create: async (params: unknown) => {
        n++;
        last = params;
        return { content: [{ type: "text", text: reply }] };
      },
    },
  } as unknown as Anthropic;
  return { client, calls: () => n, lastParams: () => last as { system: string; messages: { content: string }[] } };
}

test("the same facts within the cache window cost ONE model call — a busy public page doesn't multiply LLM spend", async () => {
  const c = countingClient("Rephrased.");
  await rephraseFacts(["a", "b"], "market", c.client, 1000);
  const second = await rephraseFacts(["a", "b"], "market", c.client, 1100);
  assert.equal(c.calls(), 1);
  assert.equal(second.source, "LLM");
});

test("changed facts are a cache miss — a cached paragraph never describes data that no longer holds", async () => {
  const c = countingClient("Rephrased.");
  await rephraseFacts(["a"], "market", c.client, 1000);
  await rephraseFacts(["a", "new fact"], "market", c.client, 1001);
  assert.equal(c.calls(), 2);
});

test("the cache expires", async () => {
  const c = countingClient("Rephrased.");
  await rephraseFacts(["a"], "wallet", c.client, 1000);
  await rephraseFacts(["a"], "wallet", c.client, 1000 + 601);
  assert.equal(c.calls(), 2);
});

test("a failed call is never cached — the next request tries again", async () => {
  await rephraseFacts(["a"], "token", fakeClient(null, { throws: true }), 1000);
  const c = countingClient("Now it works.");
  const r = await rephraseFacts(["a"], "token", c.client, 1001);
  assert.equal(r.source, "LLM");
  assert.equal(c.calls(), 1);
});

test("every purpose carries the same no-invention rules — only the framing line differs", () => {
  for (const p of ["token", "market", "wallet"] as const) {
    const sys = systemPromptFor(p);
    assert.match(sys, /Use ONLY the facts/);
    assert.match(sys, /Never predict price/);
    assert.match(sys, /Never tell anyone to buy, sell, or hold/);
  }
});

test("the model is sent only the facts list — nothing else from the caller", async () => {
  const c = countingClient("ok");
  await rephraseFacts(["fact one", "fact two"], "wallet", c.client, 1000);
  assert.equal(c.lastParams().messages[0].content, `Facts:\n${JSON.stringify(["fact one", "fact two"])}`);
});

test("an empty facts list never calls the model", async () => {
  const c = countingClient("should not happen");
  const r = await rephraseFacts([], "market", c.client, 1000);
  assert.equal(c.calls(), 0);
  assert.equal(r.source, "DETERMINISTIC_FALLBACK");
});
