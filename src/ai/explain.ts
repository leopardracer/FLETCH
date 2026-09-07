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

  const bullets = movementSignals.map((s) => `${s.explanation} (${s.evidence})`);
  if (bullets.length === 0) {
    bullets.push("Unavailable — not enough signal data yet to explain recent movement.");
  }

  const risks = risk.findings.filter((f) => f.level !== "LOW").map((f) => `[${f.level}] ${f.evidence}`);
  if (risks.length === 0) {
    risks.push("[LOW] " + (risk.findings[0]?.evidence ?? "no elevated risk findings"));
  }

  return { bullets, risks, insufficientData: movementSignals.length === 0 };
}
