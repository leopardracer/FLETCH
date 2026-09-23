import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "./client.js";
import { rephraseFacts, type NaturalLanguageSummary } from "./rephrase.js";
import type { RadarEntry } from "../radar/radarService.js";
import type { StoredSignal } from "../persistence/signalsStore.js";
import type { SignalType } from "../signals/types.js";

/**
 * FLETCH's AI Market Brief — "what's happening on Robinhood Chain right
 * now", in one paragraph.
 *
 * Same safe pattern as every AI feature here: buildMarketBriefFacts turns
 * data FLETCH already computed (Radar, the persisted signal feed, the
 * monitoring queue) into plain fact strings, and only those go to the
 * model. Tokens are referred to by shortened address, never by their
 * on-chain symbol/name — those are attacker-controlled text, and a market
 * brief shown on a public page must never be a channel for a deployer's
 * prompt injection (or a deployer's marketing).
 */

export interface MarketBriefInput {
  radar: RadarEntry[];
  /** Recent signals, any order — filtered to the window here. */
  signals: StoredSignal[];
  monitoredTokens: number;
  windowSeconds: number;
  now: number;
}

const READABLE: Partial<Record<SignalType, string>> = {
  BUY_PRESSURE: "buy pressure",
  SELL_PRESSURE: "sell pressure",
  WHALE_BUY_FROM_CURVE: "whale buys off the curve",
  WHALE_SELL_TO_CURVE: "whale sells into the curve",
  WHALE_TRANSFER: "large wallet-to-wallet transfers",
  HOLDER_GROWTH: "holder growth",
  HOLDER_DECLINE: "holder decline",
  LIQUIDITY_INCREASE: "liquidity added",
  LIQUIDITY_DECREASE: "liquidity pulled",
  ACTIVITY_ACCELERATION: "trading acceleration above the token's own baseline",
  PRICE_UP: "price up",
  PRICE_DOWN: "price down",
  DEPLOYER_RISK: "deployer risk",
  BUNDLED_WALLETS: "bundled wallets",
  SERIAL_DEPLOYER: "serial deployers",
  HOLDER_CONCENTRATION: "holder concentration",
  THIN_LIQUIDITY: "thin liquidity",
  PHASE_CHANGE: "graduations off the curve",
};

/**
 * A HOLDER_CONCENTRATION signal on a token with fewer than 10 holders says
 * "only N holders so far", not "the supply is concentrated" — and rows
 * written before that fix say "top 10 holders own 100%", which with under
 * 10 holders is arithmetic, not a finding. Either way the brief must not
 * report it as concentration or count it as HIGH/CRITICAL.
 */
export function isFewHoldersSignal(s: { type: string; evidence?: string | null }): boolean {
  if (s.type !== "HOLDER_CONCENTRATION") return false;
  const ev = s.evidence ?? "";
  return /^only \d+ holders? so far/.test(ev) || /\bown 100% of tracked supply\b/.test(ev);
}

/** What a signal is called in the brief — HOLDER_CONCENTRATION splits by meaning. */
function readableLabel(s: { type: SignalType; evidence?: string | null }): string {
  if (isFewHoldersSignal(s)) return "tokens with very few holders yet";
  return READABLE[s.type] ?? s.type;
}

export function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function buildMarketBriefFacts(input: MarketBriefInput): string[] {
  const minutes = Math.round(input.windowSeconds / 60);
  const inWindow = input.signals.filter((s) => input.now - s.timestamp <= input.windowSeconds);
  const facts: string[] = [];

  if (inWindow.length === 0 && input.radar.length === 0) {
    facts.push(
      input.monitoredTokens > 0
        ? `FLETCH is monitoring ${input.monitoredTokens} token(s), and no on-chain signal fired in the last ${minutes} minutes.`
        : "FLETCH hasn't recorded any on-chain activity yet — there is nothing to summarize."
    );
    return facts;
  }

  const tokens = new Set(inWindow.map((s) => s.token));
  facts.push(`In the last ${minutes} minutes FLETCH recorded ${inWindow.length} on-chain signal(s) across ${tokens.size} token(s); ${input.monitoredTokens} token(s) are being monitored.`);

  const byLabel = new Map<string, number>();
  for (const s of inWindow) {
    const label = readableLabel(s);
    byLabel.set(label, (byLabel.get(label) ?? 0) + 1);
  }
  const topTypes = [...byLabel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (topTypes.length > 0) {
    facts.push(`Most common: ${topTypes.map(([label, n]) => `${label} (${n})`).join(", ")}.`);
  }

  const severe = inWindow.filter((s) => (s.severity === "HIGH" || s.severity === "CRITICAL") && !isFewHoldersSignal(s));
  if (severe.length > 0) {
    const severeTokens = new Set(severe.map((s) => s.token)).size;
    facts.push(`${severe.length} of those signals were HIGH or CRITICAL severity, on ${severeTokens} token(s).`);
  }

  for (const [i, e] of input.radar.slice(0, 3).entries()) {
    const risk = e.riskLevel ? `risk level ${e.riskLevel}` : "risk level not yet computed";
    const what = isFewHoldersSignal(e.topSignal)
      ? "very few holders so far, too few for a top-10 share to mean anything"
      : `${e.topSignal.explanation}${e.topSignal.evidence && e.topSignal.evidence !== e.topSignal.explanation ? ` (${e.topSignal.evidence})` : ""}`;
    facts.push(
      `Radar #${i + 1}: token ${shortAddress(e.token)} — ${what}; ` +
        `${e.distinctSignalTypes} distinct signal type(s) converging, ${risk}` +
        (e.topSignalLifecycle ? `; that signal is ${e.topSignalLifecycle.stage} (${e.topSignalLifecycle.recentCount} in the last window vs ${e.topSignalLifecycle.previousCount} before).` : ".")
    );
  }

  return facts;
}

export interface MarketBrief {
  generatedAt: number;
  windowSeconds: number;
  facts: string[];
  summary: NaturalLanguageSummary;
}

export async function buildMarketBrief(input: MarketBriefInput, client: Anthropic | null = getAnthropicClient()): Promise<MarketBrief> {
  const facts = buildMarketBriefFacts(input);
  const summary = await rephraseFacts(facts, "market", client, input.now);
  return { generatedAt: input.now, windowSeconds: input.windowSeconds, facts, summary };
}
