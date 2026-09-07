import { getPreviousSnapshot, recordSnapshot } from "../persistence/snapshots.js";
import { recordSignal } from "../persistence/signalsStore.js";
import { detectSignals } from "./signalEngine.js";
import { analyzeRisk, type RiskReport } from "../risk/riskAnalysis.js";
import { computeFletchScore, type FletchScore } from "../scoring/fletchScore.js";
import type { TokenMetrics } from "../data/types.js";
import type { DetectedLaunch } from "../chain/hunt.js";
import type { SmartMoneyReport } from "../wallets/smartMoney.js";
import type { SocialReport } from "../social/social.js";
import type { Signal } from "./types.js";

/**
 * "What changed in the last 10 minutes?" is the brief's own framing for
 * why persistence exists — this is that window, applied consistently to
 * every trend-based risk finding, score component, and signal so they
 * all agree on what "recent" means for a single token read.
 */
export const COMPARISON_WINDOW_SECONDS = 600;

export interface Analysis {
  risk: RiskReport;
  score: FletchScore;
  signals: Signal[];
}

/**
 * The single place chain metrics become risk + score + signals, and get
 * persisted. Used by both the API (on every token-page read) and the
 * optional background poller (index.ts) — so a page view and a poll cycle
 * produce identical, comparable results.
 */
export function analyzeAndPersist(
  token: `0x${string}`,
  launch: DetectedLaunch | null,
  metrics: TokenMetrics,
  smartMoney: SmartMoneyReport,
  social: SocialReport
): Analysis {
  const previousSnapshot = getPreviousSnapshot(token, COMPARISON_WINDOW_SECONDS);
  const risk = analyzeRisk(launch, metrics, previousSnapshot);
  const score = computeFletchScore(metrics, risk, smartMoney, social, previousSnapshot, launch?.curve);
  const signals = detectSignals({ metrics, risk, curveAddress: launch?.curve, previousSnapshot });

  recordSnapshot(token, metrics, score);
  for (const s of signals) recordSignal(token, s);

  return { risk, score, signals };
}
