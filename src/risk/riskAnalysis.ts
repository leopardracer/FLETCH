import { devBuyPercentOfCurveSupply, type DetectedLaunch } from "../chain/hunt.js";
import type { TokenMetrics } from "../data/types.js";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface RiskFinding {
  level: RiskLevel;
  evidence: string;
}

export interface RiskReport {
  level: RiskLevel;
  findings: RiskFinding[];
  /** 0-100, higher = safer. Feeds the FLETCH Score's "Safety" component. */
  safetyScore: number;
}

const LEVEL_WEIGHT: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

/**
 * Every finding here comes from a real chain read (launch event data or
 * live holder/liquidity metrics) with the exact evidence stated — no
 * "SCAM" label without a number attached. Extends GTTM's huntScore.ts
 * concern-counting (launch-moment only) with post-launch signals
 * (holder concentration, liquidity depth) that GTTM didn't track since it
 * only ever looked at one token at launch time.
 */
export function analyzeRisk(launch: DetectedLaunch | null, metrics: TokenMetrics | null): RiskReport {
  const findings: RiskFinding[] = [];

  if (launch) {
    const devBuyPct = devBuyPercentOfCurveSupply(launch.devBuyTokens);
    if (devBuyPct !== null) {
      if (devBuyPct > 5) {
        findings.push({ level: "HIGH", evidence: `dev bought ${devBuyPct.toFixed(1)}% of curve-sold supply at launch` });
      } else if (devBuyPct > 1) {
        findings.push({ level: "MEDIUM", evidence: `dev bought ${devBuyPct.toFixed(1)}% of curve-sold supply at launch` });
      }
    }

    if (launch.exemptWalletCount > 0) {
      findings.push({
        level: launch.exemptWalletCount >= 3 ? "HIGH" : "MEDIUM",
        evidence: `${launch.exemptWalletCount} wallet(s) declared exempt from opening snipe tax (declared bundle)`,
      });
    }

    if (launch.deployerLaunchCountInWindow > 1) {
      findings.push({
        level: launch.deployerLaunchCountInWindow >= 5 ? "HIGH" : "MEDIUM",
        evidence: `serial deployer: ${launch.deployerLaunchCountInWindow} launches from this address in the scanned window`,
      });
    }

    if (launch.devBuyTaxBps !== null && launch.devBuyTaxBps < 9900) {
      findings.push({
        level: "MEDIUM",
        evidence: `dev's own buy paid a reduced tax (${(launch.devBuyTaxBps / 100).toFixed(1)}%) — dev may be self-exempted`,
      });
    }
  }

  if (metrics) {
    if (metrics.topHolderConcentrationPercent !== null) {
      const c = metrics.topHolderConcentrationPercent;
      if (c > 70) findings.push({ level: "CRITICAL", evidence: `top 10 holders own ${c.toFixed(0)}% of tracked supply` });
      else if (c > 50) findings.push({ level: "HIGH", evidence: `top 10 holders own ${c.toFixed(0)}% of tracked supply` });
      else if (c > 35) findings.push({ level: "MEDIUM", evidence: `top 10 holders own ${c.toFixed(0)}% of tracked supply` });
    }

    if (metrics.liquidityUsd !== null) {
      if (metrics.liquidityUsd < 5_000) findings.push({ level: "HIGH", evidence: `liquidity is only $${metrics.liquidityUsd.toFixed(0)}` });
      else if (metrics.liquidityUsd < 20_000) findings.push({ level: "MEDIUM", evidence: `liquidity is $${metrics.liquidityUsd.toFixed(0)} — thin` });
    }
  }

  if (findings.length === 0) {
    findings.push({ level: "LOW", evidence: "no red flags found in launch data or currently available holder/liquidity metrics" });
  }

  const level = findings.reduce<RiskLevel>((acc, f) => (LEVEL_WEIGHT[f.level] > LEVEL_WEIGHT[acc] ? f.level : acc), "LOW");
  const concern = findings.reduce((s, f) => s + LEVEL_WEIGHT[f.level], 0);
  const safetyScore = Math.max(0, 100 - concern * 12);

  return { level, findings, safetyScore };
}
