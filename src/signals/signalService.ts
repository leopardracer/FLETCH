import { getPreviousSnapshot, getSnapshotHistory, recordSnapshot } from "../persistence/snapshots.js";
import { recordSignal, hasSignalSince } from "../persistence/signalsStore.js";
import { detectSignals } from "./signalEngine.js";
import { analyzeRisk, type RiskReport } from "../risk/riskAnalysis.js";
import { computeFletchScore, type FletchScore } from "../scoring/fletchScore.js";
import type { TokenMetrics } from "../data/types.js";
import type { DetectedLaunch } from "../chain/hunt.js";
import type { SmartMoneyReport } from "../wallets/smartMoney.js";
import type { SocialReport } from "../social/social.js";
import type { Signal, SignalType } from "./types.js";

/**
 * Found live once checks became frequent: 3,265 signals in an hour from 39
 * checks. Every check re-read the same recent window, so every whale move
 * in it was filed again (the evidence names the same tx), and point-in-time
 * risk findings ("liquidity is only $0") were filed again unchanged. The
 * feed, the radar and the brief were counting the same events dozens of
 * times.
 *  - A whale move is one on-chain event: filed once per transaction, ever.
 *  - A risk finding is a standing fact: filed again only if its evidence
 *    changed, or once a day to stay visible.
 *  - Trend signals (buy pressure, holder growth, …) compare two snapshots,
 *    so each one is new information and is always filed.
 */
const PER_TX_TYPES = new Set<SignalType>(["WHALE_BUY_FROM_CURVE", "WHALE_SELL_TO_CURVE", "WHALE_TRANSFER"]);
const STANDING_TYPES = new Set<SignalType>(["DEPLOYER_RISK", "BUNDLED_WALLETS", "SERIAL_DEPLOYER", "HOLDER_CONCENTRATION", "THIN_LIQUIDITY"]);
const STANDING_REPEAT_SECONDS = 24 * 3600;

export function isRepeat(token: string, s: Signal, now: number): boolean {
  if (PER_TX_TYPES.has(s.type)) return hasSignalSince(token, s.type, s.evidence, 0);
  if (STANDING_TYPES.has(s.type)) return hasSignalSince(token, s.type, s.evidence, now - STANDING_REPEAT_SECONDS);
  return false;
}

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
  social: SocialReport,
  now: number = Math.floor(Date.now() / 1000),
  opts: { persistSignals?: boolean } = {}
): Analysis {
  const previousSnapshot = getPreviousSnapshot(token, COMPARISON_WINDOW_SECONDS, now);
  const risk = analyzeRisk(launch, metrics, previousSnapshot);
  const score = computeFletchScore(metrics, risk, smartMoney, social, previousSnapshot, launch?.curve);
  // Full history (not just the one previousSnapshot) is what lets
  // ACTIVITY_ACCELERATION compare against this token's own real lifetime
  // average instead of only the last check — see signalEngine.ts's
  // eligibility gate for when that baseline is actually trusted.
  const snapshotHistory = getSnapshotHistory(token);
  const signals = detectSignals({
    metrics,
    risk,
    curveAddress: launch?.curve,
    previousSnapshot,
    launchTimestamp: launch?.launchTimestamp,
    snapshotHistory,
    now,
  });

  // Signals are only persisted alongside a genuinely new snapshot — otherwise a
  // rapid repeat read (same rate-limit window) would re-file identical signal
  // rows every time, even though nothing new was actually observed.
  const wroteNewSnapshot = recordSnapshot(token, metrics, score, risk.level, now);
  if (wroteNewSnapshot && opts.persistSignals !== false) {
    for (const s of signals) if (!isRepeat(token, s, now)) recordSignal(token, s);
  }

  return { risk, score, signals };
}
