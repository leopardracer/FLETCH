import type { TokenMetrics } from "../data/types.js";
import type { RiskReport } from "../risk/riskAnalysis.js";
import type { FletchScore } from "../scoring/fletchScore.js";

export interface WhyIsItMoving {
  bullets: string[];
  risks: string[];
  insufficientData: boolean;
}

/**
 * Deliberately NOT a free-form LLM call. Every bullet here is a direct,
 * templated rendering of a structured number FLETCH already computed —
 * same philosophy as GTTM's core/signals.ts ("a small set of clearly
 * stated, deterministic rules... nothing that pretends to be smarter than
 * it is"). This is what the brief means by "AI must not invent market
 * data": the safest way to guarantee that is to never let free text
 * generation touch the numbers at all.
 *
 * If you want this phrased more naturally later, the safe pattern is:
 * generate these bullets first, then pass ONLY this array to an LLM with
 * an instruction to rephrase without adding facts — never let the model
 * see raw metrics and write from scratch.
 */
export function explainWhyItsMoving(metrics: TokenMetrics, risk: RiskReport, score: FletchScore): WhyIsItMoving {
  const bullets: string[] = [];

  if (metrics.buyCountWindow + metrics.sellCountWindow > 0) {
    bullets.push(`${metrics.buyCountWindow} buys vs ${metrics.sellCountWindow} sells since launch`);
  }
  if (metrics.holderCount !== null) {
    bullets.push(`${metrics.holderCount} holders tracked${metrics.holderCountIsLifetime ? " (lifetime count)" : " (in scan window)"}`);
  }
  if (metrics.liquidityUsd !== null) {
    bullets.push(`liquidity currently $${metrics.liquidityUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  } else if (metrics.liquidityUsdUnavailableReason) {
    bullets.push(`liquidity in USD: unavailable (${metrics.liquidityUsdUnavailableReason})`);
  }
  if (score.components.smartMoney.value === null) {
    bullets.push(`smart-money activity: unavailable (${score.components.smartMoney.reason})`);
  }
  if (score.components.social.value === null) {
    bullets.push(`social momentum: unavailable (${score.components.social.reason})`);
  }

  const risks = risk.findings
    .filter((f) => f.level !== "LOW")
    .map((f) => `[${f.level}] ${f.evidence}`);
  if (risks.length === 0) {
    risks.push("[LOW] " + (risk.findings[0]?.evidence ?? "no elevated risk findings"));
  }

  return { bullets, risks, insufficientData: bullets.length === 0 };
}
