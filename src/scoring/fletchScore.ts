import type { TokenMetrics } from "../data/types.js";
import type { RiskReport } from "../risk/riskAnalysis.js";
import type { SmartMoneyReport } from "../wallets/smartMoney.js";
import type { SocialReport } from "../social/social.js";

export interface ComponentScore {
  value: number | null; // null = UNAVAILABLE, not zero
  label: string;
  reason?: string; // populated when value is null
}

export interface FletchScore {
  overall: number | null; // null if too few components are available to be meaningful
  overallUnavailableReason?: string;
  components: {
    momentum: ComponentScore;
    smartMoney: ComponentScore;
    social: ComponentScore;
    liquidity: ComponentScore;
    holderGrowth: ComponentScore;
    safety: ComponentScore;
  };
  /** Which components actually fed the overall number — for the "why did this score change" explanation. */
  weightsUsed: Record<string, number>;
}

const WEIGHTS = { momentum: 0.25, smartMoney: 0.2, social: 0.15, liquidity: 0.15, holderGrowth: 0.15, safety: 0.1 };

/**
 * Explainable by construction: every component is either a direct
 * transform of a real metric, or an explicit null with a stated reason —
 * never a filled-in guess. The overall score only weights the components
 * that are actually available, and says so, rather than silently treating
 * an unavailable component as zero (which would unfairly tank every score
 * until smart-money/social are built) or as neutral (which would be a
 * fabricated number).
 */
export function computeFletchScore(
  metrics: TokenMetrics,
  risk: RiskReport,
  smartMoney: SmartMoneyReport,
  social: SocialReport
): FletchScore {
  const momentum = scoreMomentum(metrics);
  const liquidity = scoreLiquidity(metrics);
  const holderGrowth = scoreHolderGrowth(metrics);
  const safety: ComponentScore = { value: risk.safetyScore, label: `${risk.level} risk` };
  const smartMoneyScore: ComponentScore = smartMoney.available
    ? { value: smartMoney.value, label: "smart money" }
    : { value: null, label: "smart money", reason: smartMoney.reason };
  const socialScore: ComponentScore = social.available
    ? { value: social.value, label: "social" }
    : { value: null, label: "social", reason: social.reason };

  const components = { momentum, smartMoney: smartMoneyScore, social: socialScore, liquidity, holderGrowth, safety };

  const available = Object.entries(components).filter(([, c]) => c.value !== null) as [
    keyof typeof WEIGHTS,
    ComponentScore
  ][];

  if (available.length === 0) {
    return {
      overall: null,
      overallUnavailableReason: "no component metrics are available yet for this token",
      components,
      weightsUsed: {},
    };
  }

  const totalWeight = available.reduce((s, [k]) => s + WEIGHTS[k], 0);
  const weightsUsed: Record<string, number> = {};
  let overall = 0;
  for (const [k, c] of available) {
    const normalizedWeight = WEIGHTS[k] / totalWeight;
    weightsUsed[k] = Math.round(normalizedWeight * 100) / 100;
    overall += (c.value as number) * normalizedWeight;
  }

  return { overall: Math.round(overall), components, weightsUsed };
}

function scoreMomentum(m: TokenMetrics): ComponentScore {
  const total = m.buyCountWindow + m.sellCountWindow;
  if (total === 0) return { value: null, label: "momentum", reason: "no buy/sell activity observed in the scanned window yet" };
  const buyRatio = m.buyCountWindow / total;
  // Activity level (log-scaled tx count) blended with buy pressure — both real, both bounded.
  const activity = Math.min(1, Math.log10(total + 1) / 2.5);
  const value = Math.round((buyRatio * 0.6 + activity * 0.4) * 100);
  return { value, label: `${m.buyCountWindow} buys / ${m.sellCountWindow} sells in window` };
}

function scoreLiquidity(m: TokenMetrics): ComponentScore {
  if (m.liquidityUsd === null) return { value: null, label: "liquidity", reason: m.liquidityUsdUnavailableReason ?? "liquidity in USD is unavailable" };
  // 0 at $0, 100 at $100k+, log-scaled so early liquidity growth still moves the needle.
  const value = Math.round(Math.min(100, (Math.log10(m.liquidityUsd + 1) / 5) * 100));
  return { value, label: `$${m.liquidityUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })} liquidity` };
}

function scoreHolderGrowth(m: TokenMetrics): ComponentScore {
  if (m.holderCount === null) return { value: null, label: "holder growth", reason: "holder count unavailable" };
  // No historical snapshot store yet (see wallets/smartMoney.ts note on persistence) — this
  // scores absolute holder count, not growth rate, until snapshots are wired up. Labeled
  // honestly rather than called "growth" without a trend to back it.
  const value = Math.round(Math.min(100, (Math.log10(m.holderCount + 1) / 3) * 100));
  return { value, label: `${m.holderCount} holders${m.holderCountIsLifetime ? " (lifetime)" : " (scan window)"}` };
}
