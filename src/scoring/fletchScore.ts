import type { TokenMetrics } from "../data/types.js";
import type { RiskReport } from "../risk/riskAnalysis.js";
import type { SmartMoneyReport } from "../wallets/smartMoney.js";
import type { SocialReport } from "../social/social.js";
import type { TokenSnapshot } from "../persistence/snapshots.js";

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
    whaleActivity: ComponentScore;
    safety: ComponentScore;
  };
  /** Which components actually fed the overall number — for the "why did this score change" explanation. */
  weightsUsed: Record<string, number>;
}

const WEIGHTS = {
  momentum: 0.22,
  smartMoney: 0.16,
  social: 0.12,
  liquidity: 0.14,
  holderGrowth: 0.14,
  whaleActivity: 0.12,
  safety: 0.1,
};

/**
 * Explainable by construction: every component is either a direct
 * transform of a real metric, or an explicit null with a stated reason —
 * never a filled-in guess. The overall score only weights the components
 * that are actually available, and says so, rather than silently treating
 * an unavailable component as zero (which would unfairly tank every score
 * until smart-money/social are built) or as neutral (which would be a
 * fabricated number).
 *
 * `previousSnapshot` and `curveAddress` are optional — without them,
 * Holder Growth falls back to an absolute-count proxy (labeled as such,
 * not called a "rate" it isn't) and Whale Activity can't classify buy vs.
 * sell direction. See docs/SCORING.md.
 */
export function computeFletchScore(
  metrics: TokenMetrics,
  risk: RiskReport,
  smartMoney: SmartMoneyReport,
  social: SocialReport,
  previousSnapshot: TokenSnapshot | null = null,
  curveAddress?: `0x${string}`
): FletchScore {
  const momentum = scoreMomentum(metrics);
  const liquidity = scoreLiquidity(metrics);
  const holderGrowth = scoreHolderGrowth(metrics, previousSnapshot);
  const whaleActivity = scoreWhaleActivity(metrics, curveAddress);
  const safety: ComponentScore = { value: risk.safetyScore, label: `${risk.level} risk` };
  const smartMoneyScore: ComponentScore = smartMoney.available
    ? { value: smartMoney.value, label: "smart money" }
    : { value: null, label: "smart money", reason: smartMoney.reason };
  const socialScore: ComponentScore = social.available
    ? { value: social.value, label: "social" }
    : { value: null, label: "social", reason: social.reason };

  const components = {
    momentum,
    smartMoney: smartMoneyScore,
    social: socialScore,
    liquidity,
    holderGrowth,
    whaleActivity,
    safety,
  };

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

function scoreHolderGrowth(m: TokenMetrics, previousSnapshot: TokenSnapshot | null): ComponentScore {
  if (m.holderCount === null) return { value: null, label: "holder growth", reason: "holder count unavailable" };

  if (previousSnapshot && previousSnapshot.holderCount !== null && previousSnapshot.holderCount > 0) {
    const pct = ((m.holderCount - previousSnapshot.holderCount) / previousSnapshot.holderCount) * 100;
    // 0% change -> 50 (neutral), +50% or more -> 100, -50% or more -> 0.
    const value = Math.round(Math.min(100, Math.max(0, 50 + pct)));
    return {
      value,
      label: `${previousSnapshot.holderCount} → ${m.holderCount} holders (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)`,
    };
  }

  // No prior snapshot yet — fall back to an absolute-count proxy, labeled honestly as not a rate.
  const value = Math.round(Math.min(100, (Math.log10(m.holderCount + 1) / 3) * 100));
  return {
    value,
    label: `${m.holderCount} holders${m.holderCountIsLifetime ? " (lifetime)" : " (scan window)"} — no history yet, showing count not growth rate`,
  };
}

function scoreWhaleActivity(m: TokenMetrics, curveAddress?: `0x${string}`): ComponentScore {
  // holderCount null means the underlying holder/transfer scan didn't complete —
  // we genuinely don't know whether whale moves happened, so this is unavailable,
  // not zero. An empty whaleMoves array with a successful scan IS real information
  // ("checked, found none") and gets a defined neutral score below.
  if (m.holderCount === null) {
    return { value: null, label: "whale activity", reason: "holder/transfer scan did not complete for this token" };
  }
  if (m.whaleMoves.length === 0) {
    return { value: 50, label: "no whale-sized transfers in the current scan window" };
  }

  let buyWeight = 0;
  let sellWeight = 0;
  let undirectedCount = 0;
  const curve = curveAddress?.toLowerCase();
  for (const w of m.whaleMoves) {
    if (curve && w.from.toLowerCase() === curve) buyWeight += w.amount;
    else if (curve && w.to.toLowerCase() === curve) sellWeight += w.amount;
    else undirectedCount++;
  }

  const directed = buyWeight + sellWeight;
  if (directed === 0) {
    const value = Math.min(65, 50 + undirectedCount * 3);
    return { value, label: `${undirectedCount} whale-sized transfer(s), direction not classified` };
  }

  const buyShare = buyWeight / directed;
  const value = Math.round(30 + buyShare * 60); // all-sell -> 30, all-buy -> 90
  const parts: string[] = [];
  if (buyWeight > 0) parts.push("buys from curve");
  if (sellWeight > 0) parts.push("sells to curve");
  return { value, label: `${m.whaleMoves.length} whale transfer(s) — ${parts.join(" & ")}` };
}
