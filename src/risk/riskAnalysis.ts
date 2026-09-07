import { devBuyPercentOfCurveSupply, type DetectedLaunch } from "../chain/hunt.js";
import type { TokenMetrics } from "../data/types.js";
import { PONS_PROTOCOL_ADDRESSES } from "../chain/pons.js";
import type { TokenSnapshot } from "../persistence/snapshots.js";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type RiskFindingCode =
  | "DEV_BUY"
  | "BUNDLED_WALLETS"
  | "SERIAL_DEPLOYER"
  | "REDUCED_DEV_TAX"
  | "HOLDER_CONCENTRATION"
  | "THIN_LIQUIDITY"
  | "LIQUIDITY_DETERIORATION"
  | "ABNORMAL_SELL_PRESSURE"
  | "WHALE_DUMPING"
  | "CLEAN";

export interface RiskFinding {
  level: RiskLevel;
  code: RiskFindingCode;
  evidence: string;
}

export interface RiskReport {
  level: RiskLevel;
  findings: RiskFinding[];
  /** 0-100, higher = safer. Feeds the FLETCH Score's "Safety" component. */
  safetyScore: number;
}

const LEVEL_WEIGHT: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const PROTOCOL_SET = new Set(PONS_PROTOCOL_ADDRESSES.map((a) => a.toLowerCase()));

/**
 * Every finding here comes from a real chain read (launch event data,
 * live holder/liquidity metrics, or a delta against a persisted snapshot)
 * with the exact evidence stated — no "SCAM" label without a number
 * attached. Covers launch-moment concern-counting (dev buy, bundled
 * wallets, serial deployer) plus post-launch signals (holder
 * concentration, liquidity depth, and trend-based findings once snapshot
 * history exists) across every token.
 *
 * `previousSnapshot` is optional and, when absent, simply means the two
 * trend-based findings (liquidity deterioration, abnormal sell pressure)
 * don't fire yet — never approximated from a single point in time.
 */
export function analyzeRisk(
  launch: DetectedLaunch | null,
  metrics: TokenMetrics | null,
  previousSnapshot: TokenSnapshot | null = null
): RiskReport {
  const findings: RiskFinding[] = [];

  if (launch) {
    const devBuyPct = devBuyPercentOfCurveSupply(launch.devBuyTokens);
    if (devBuyPct !== null) {
      if (devBuyPct > 5) {
        findings.push({ level: "HIGH", code: "DEV_BUY", evidence: `dev bought ${devBuyPct.toFixed(1)}% of curve-sold supply at launch` });
      } else if (devBuyPct > 1) {
        findings.push({ level: "MEDIUM", code: "DEV_BUY", evidence: `dev bought ${devBuyPct.toFixed(1)}% of curve-sold supply at launch` });
      }
    }

    if (launch.exemptWalletCount > 0) {
      findings.push({
        level: launch.exemptWalletCount >= 3 ? "HIGH" : "MEDIUM",
        code: "BUNDLED_WALLETS",
        evidence: `${launch.exemptWalletCount} wallet(s) declared exempt from opening snipe tax (declared bundle)`,
      });
    }

    if (launch.deployerLaunchCountInWindow > 1) {
      findings.push({
        level: launch.deployerLaunchCountInWindow >= 5 ? "HIGH" : "MEDIUM",
        code: "SERIAL_DEPLOYER",
        evidence: `serial deployer: ${launch.deployerLaunchCountInWindow} launches from this address in the scanned window`,
      });
    }

    if (launch.devBuyTaxBps !== null && launch.devBuyTaxBps < 9900) {
      findings.push({
        level: "MEDIUM",
        code: "REDUCED_DEV_TAX",
        evidence: `dev's own buy paid a reduced tax (${(launch.devBuyTaxBps / 100).toFixed(1)}%) — dev may be self-exempted`,
      });
    }
  }

  if (metrics) {
    if (metrics.topHolderConcentrationPercent !== null) {
      const c = metrics.topHolderConcentrationPercent;
      if (c > 70) findings.push({ level: "CRITICAL", code: "HOLDER_CONCENTRATION", evidence: `top 10 holders own ${c.toFixed(0)}% of tracked supply` });
      else if (c > 50) findings.push({ level: "HIGH", code: "HOLDER_CONCENTRATION", evidence: `top 10 holders own ${c.toFixed(0)}% of tracked supply` });
      else if (c > 35) findings.push({ level: "MEDIUM", code: "HOLDER_CONCENTRATION", evidence: `top 10 holders own ${c.toFixed(0)}% of tracked supply` });
    }

    if (metrics.liquidityUsd !== null) {
      if (metrics.liquidityUsd < 5_000) findings.push({ level: "HIGH", code: "THIN_LIQUIDITY", evidence: `liquidity is only $${metrics.liquidityUsd.toFixed(0)}` });
      else if (metrics.liquidityUsd < 20_000) findings.push({ level: "MEDIUM", code: "THIN_LIQUIDITY", evidence: `liquidity is $${metrics.liquidityUsd.toFixed(0)} — thin` });
    }

    // Whale dumping: large transfers INTO the curve (selling), classified only
    // when we know the curve address for this token — never guessed.
    if (launch && metrics.whaleMoves.length > 0) {
      const curve = launch.curve.toLowerCase();
      const dumps = metrics.whaleMoves.filter((w) => w.to.toLowerCase() === curve);
      if (dumps.length > 0) {
        const total = dumps.reduce((s, w) => s + w.amount, 0);
        const level: RiskLevel = dumps.length >= 3 ? "HIGH" : "MEDIUM";
        findings.push({
          level,
          code: "WHALE_DUMPING",
          evidence: `${dumps.length} whale sell(s) into the curve totaling ${total.toLocaleString(undefined, { maximumFractionDigits: 0 })} tokens in the current scan window`,
        });
      }
    }
  }

  // Trend-based findings — only when a prior snapshot actually exists.
  if (metrics && previousSnapshot) {
    if (metrics.liquidityUsd !== null && previousSnapshot.liquidityUsd !== null && previousSnapshot.liquidityUsd > 0) {
      const dropPct = ((previousSnapshot.liquidityUsd - metrics.liquidityUsd) / previousSnapshot.liquidityUsd) * 100;
      if (dropPct > 30) {
        findings.push({
          level: "HIGH",
          code: "LIQUIDITY_DETERIORATION",
          evidence: `liquidity dropped ${dropPct.toFixed(0)}% since the last check ($${previousSnapshot.liquidityUsd.toFixed(0)} → $${metrics.liquidityUsd.toFixed(0)})`,
        });
      } else if (dropPct > 15) {
        findings.push({
          level: "MEDIUM",
          code: "LIQUIDITY_DETERIORATION",
          evidence: `liquidity dropped ${dropPct.toFixed(0)}% since the last check ($${previousSnapshot.liquidityUsd.toFixed(0)} → $${metrics.liquidityUsd.toFixed(0)})`,
        });
      }
    }

    const recentBuys = metrics.buyCountWindow - previousSnapshot.buyCountWindow;
    const recentSells = metrics.sellCountWindow - previousSnapshot.sellCountWindow;
    if (recentSells >= 3 && recentSells > recentBuys * 2) {
      findings.push({
        level: recentSells > recentBuys * 4 ? "HIGH" : "MEDIUM",
        code: "ABNORMAL_SELL_PRESSURE",
        evidence: `${recentSells} sells vs ${Math.max(0, recentBuys)} buys since the last check`,
      });
    }
  }

  if (findings.length === 0) {
    findings.push({ level: "LOW", code: "CLEAN", evidence: "no red flags found in launch data or currently available holder/liquidity metrics" });
  }

  const level = findings.reduce<RiskLevel>((acc, f) => (LEVEL_WEIGHT[f.level] > LEVEL_WEIGHT[acc] ? f.level : acc), "LOW");
  const concern = findings.reduce((s, f) => s + LEVEL_WEIGHT[f.level], 0);
  const safetyScore = Math.max(0, 100 - concern * 12);

  return { level, findings, safetyScore };
}
