import type { Signal, SignalSeverity } from "../signals/types.js";
import type { RiskReport } from "../risk/riskAnalysis.js";

export interface WhyIsItMoving {
  bullets: string[];
  risks: string[];
  insufficientData: boolean;
}

/** Risk-derived signal types are shown in the Risk section instead — avoids saying the same finding twice. */
const RISK_SIGNAL_TYPES = new Set(["DEPLOYER_RISK", "BUNDLED_WALLETS", "SERIAL_DEPLOYER", "HOLDER_CONCENTRATION", "THIN_LIQUIDITY"]);

const SEVERITY_RANK: Record<SignalSeverity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

/**
 * Deliberately NOT a free-form LLM call. Every bullet is a direct render
 * of a `Signal` the signal engine already detected (src/signals/signalEngine.ts)
 * — `signal.explanation` plus its `evidence`, nothing added. This is the
 * safest way to guarantee the brief's "must NEVER hallucinate" rule: never
 * let generated text see raw numbers and write from scratch, only ever
 * let it re-render numbers that were already computed deterministically.
 *
 * If you want this phrased more naturally later, the safe pattern is:
 * pass ONLY this bullets array to an LLM with an instruction to rephrase
 * without adding facts — never let the model see raw metrics directly.
 */
export function explainWhyItsMoving(signals: Signal[], risk: RiskReport): WhyIsItMoving {
  const movementSignals = signals
    .filter((s) => !RISK_SIGNAL_TYPES.has(s.type))
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  // Found on real data: one busy token produced 43 near-identical whale
  // bullets. Repeated whale buys/sells are rolled into one line each (count,
  // total, largest with its tx) so the explanation stays readable and the
  // AI rephrase gets the facts, not a wall of duplicates. Capped at 8 lines.
  const bullets: string[] = [];
  const agg = new Map<string, Signal[]>();
  const slot = new Map<string, number>(); // keeps each rolled-up line where its most severe signal ranked
  for (const s of movementSignals) {
    if (s.type === "WHALE_BUY_FROM_CURVE" || s.type === "WHALE_SELL_TO_CURVE" || s.type === "WHALE_TRANSFER") {
      if (!agg.has(s.type)) { agg.set(s.type, []); slot.set(s.type, bullets.length); bullets.push(""); }
      agg.get(s.type)!.push(s);
    } else bullets.push(`${s.explanation} (${s.evidence})`);
  }
  const label: Record<string, [string, string]> = {
    WHALE_BUY_FROM_CURVE: ["large buy(s) came directly off the bonding curve", "bought"],
    WHALE_SELL_TO_CURVE: ["large sell(s) went directly into the bonding curve", "sold"],
    WHALE_TRANSFER: ["large wallet-to-wallet transfer(s) — direction/intent isn't inferred from these alone", "moved"],
  };
  for (const [type, list] of agg) {
    const at = slot.get(type)!;
    if (list.length === 1) { bullets[at] = `${list[0].explanation} (${list[0].evidence})`; continue; }
    const amt = (s: Signal) => Number((s.evidence.match(/^([\d,]+)/)?.[1] ?? "0").replace(/,/g, ""));
    const total = list.reduce((a, s) => a + amt(s), 0);
    const biggest = list.reduce((a, s) => (amt(s) > amt(a) ? s : a), list[0]);
    bullets[at] = `${list.length} ${label[type][0]}, ${total.toLocaleString("en-US")} tokens ${label[type][1]} in total (largest: ${biggest.evidence}).`;
  }
  bullets.splice(8);
  if (bullets.length === 0) {
    bullets.push("Unavailable — not enough signal data yet to explain recent movement.");
  }

  const risks = risk.findings.filter((f) => f.level !== "LOW").map((f) => `[${f.level}] ${f.evidence}`);
  if (risks.length === 0) {
    risks.push("[LOW] " + (risk.findings[0]?.evidence ?? "no elevated risk findings"));
  }

  return { bullets, risks, insufficientData: movementSignals.length === 0 };
}
