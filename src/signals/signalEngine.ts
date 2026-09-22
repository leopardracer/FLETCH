import type { TokenMetrics } from "../data/types.js";
import type { RiskReport, RiskFindingCode } from "../risk/riskAnalysis.js";
import type { TokenSnapshot } from "../persistence/snapshots.js";
import type { Signal, SignalType } from "./types.js";
import { PONS_PROTOCOL_ADDRESSES } from "../chain/pons.js";

const PROTOCOL_SET = new Set(PONS_PROTOCOL_ADDRESSES.map((a) => a.toLowerCase()));

/** Risk findings that map 1:1 onto a signal — everything else in a RiskReport (CLEAN) isn't signal-worthy on its own. */
const RISK_CODE_TO_SIGNAL: Partial<Record<RiskFindingCode, SignalType>> = {
  DEV_BUY: "DEPLOYER_RISK",
  BUNDLED_WALLETS: "BUNDLED_WALLETS",
  SERIAL_DEPLOYER: "SERIAL_DEPLOYER",
  REDUCED_DEV_TAX: "DEPLOYER_RISK",
  HOLDER_CONCENTRATION: "HOLDER_CONCENTRATION",
  THIN_LIQUIDITY: "THIN_LIQUIDITY",
};

export interface DetectSignalsInput {
  metrics: TokenMetrics;
  risk: RiskReport;
  /** Curve address for this token, if known — required to classify a whale
   *  move as buying-from-curve / selling-to-curve rather than an ambiguous
   *  wallet-to-wallet transfer. Omit if unknown; moves are then reported
   *  as neutral WHALE_TRANSFER instead of guessed direction. */
  curveAddress?: `0x${string}`;
  /** Most recent snapshot older than the signal engine's own comparison
   *  window (see signalService.ts) — null means no trend signals fire,
   *  only point-in-time ones. */
  previousSnapshot: TokenSnapshot | null;
  /** Real unix-seconds launch time (see chain/hunt.ts's DetectedLaunch),
   *  not estimated from block number. null = unknown (enrichment read
   *  failed, or no launch record at all) — ACTIVITY_ACCELERATION then
   *  always uses its fixed-threshold fallback, never a guessed baseline. */
  launchTimestamp?: number | null;
  /** This token's full available snapshot history (any order — sorted
   *  internally), used to compute a real lifetime-average trade rate for
   *  ACTIVITY_ACCELERATION instead of comparing only against the single
   *  previous snapshot. Honesty caveat, worth keeping in mind wherever
   *  this baseline is surfaced: the trade count is a sum of deltas
   *  between FLETCH's own recorded snapshots, so it's "average rate
   *  since FLETCH started watching this token," not literally "since
   *  on-chain launch" for a token FLETCH discovered well after it
   *  launched — see the eligibility gate in detectSignals for how that's
   *  kept from being misleading (a young-enough token skips the baseline
   *  entirely rather than compute one from a mostly-unobserved lifetime). */
  snapshotHistory?: TokenSnapshot[];
  now?: number; // unix seconds — injectable for deterministic tests
}

/** A token must be at least this old (real launch time, not first-seen)
 *  before ACTIVITY_ACCELERATION trusts a lifetime-average baseline over
 *  it — otherwise "this is its own baseline" is a trivial, meaningless
 *  comparison for a token that's only been alive a few minutes. */
const MIN_LAUNCH_AGE_FOR_BASELINE_SECONDS = 3600;
/** Below this many snapshot data points, an "average" is a couple of
 *  noisy samples, not a real baseline — falls back to the fixed
 *  threshold instead of trusting it. */
const MIN_HISTORY_POINTS_FOR_BASELINE = 3;
/** A computed baseline below this floor is close enough to zero that
 *  any small real number of trades would compute as an enormous, noisy
 *  multiplier (e.g. 1 trade vs a 0.001/min baseline = "1000x") — treated
 *  as "no usable baseline" rather than trusted at face value. */
const MIN_BASELINE_RATE_PER_MINUTE = 0.02;

/** Real lifetime-average trades/minute for this token, or null if the
 *  token's too young or FLETCH doesn't have enough history to trust one
 *  — see the constants above for the exact eligibility bar. Pure
 *  function of already-known inputs; no chain calls, no clock reads. */
function computeLifetimeBaselineRate(launchTimestamp: number | null | undefined, history: TokenSnapshot[] | undefined, now: number): number | null {
  if (!launchTimestamp || !history || history.length < MIN_HISTORY_POINTS_FOR_BASELINE) return null;
  if (now - launchTimestamp < MIN_LAUNCH_AGE_FOR_BASELINE_SECONDS) return null;

  const sorted = [...history].sort((a, b) => a.takenAt - b.takenAt);
  let totalTrades = 0;
  for (let i = 1; i < sorted.length; i++) {
    const delta = sorted[i].buyCountWindow + sorted[i].sellCountWindow - (sorted[i - 1].buyCountWindow + sorted[i - 1].sellCountWindow);
    if (delta > 0) totalTrades += delta; // a negative delta means the window itself reset/shrank, not negative trades — never subtracted
  }

  const spanMinutes = (sorted[sorted.length - 1].takenAt - sorted[0].takenAt) / 60;
  if (spanMinutes <= 0) return null;

  const rate = totalTrades / spanMinutes;
  return rate >= MIN_BASELINE_RATE_PER_MINUTE ? rate : null;
}

/**
 * Pure function: same inputs, same signals, every time. No chain calls,
 * no randomness, no clock reads unless `now` is omitted (defaults to
 * Date.now() only at the call site, never inside a branch). Every signal's
 * `evidence` names the exact number(s) that produced it — see
 * docs/SIGNALS.md for the severity/confidence rules this implements.
 */
export function detectSignals(input: DetectSignalsInput): Signal[] {
  const { metrics, risk, curveAddress, previousSnapshot } = input;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const signals: Signal[] = [];

  // --- Buy/sell pressure (point-in-time, needs a minimum sample) ---
  const totalTx = metrics.buyCountWindow + metrics.sellCountWindow;
  if (totalTx >= 3) {
    const buyRatio = metrics.buyCountWindow / totalTx;
    const confidence = Math.min(90, 40 + totalTx * 3);
    if (buyRatio >= 0.75) {
      signals.push(sig("BUY_PRESSURE", buyRatio >= 0.9 ? "HIGH" : "MEDIUM", confidence, `${metrics.buyCountWindow} buys vs ${metrics.sellCountWindow} sells`, "Buy activity is outweighing sell activity in the current scan window.", now));
    } else if (buyRatio <= 0.25) {
      signals.push(sig("SELL_PRESSURE", buyRatio <= 0.1 ? "HIGH" : "MEDIUM", confidence, `${metrics.sellCountWindow} sells vs ${metrics.buyCountWindow} buys`, "Sell activity is outweighing buy activity in the current scan window.", now));
    }
  }

  // --- Whale moves (point-in-time, real transfers) ---
  for (const w of metrics.whaleMoves) {
    const to = w.to.toLowerCase();
    const from = w.from.toLowerCase();
    const isBuyFromCurve = curveAddress && from === curveAddress.toLowerCase();
    const isSellToCurve = curveAddress && to === curveAddress.toLowerCase();
    const amountStr = w.amount.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (isBuyFromCurve) {
      signals.push(sig("WHALE_BUY_FROM_CURVE", "MEDIUM", 75, `${amountStr} tokens bought from the curve in tx ${w.txHash}`, "A large buy came directly off the bonding curve.", now, w.blockNumber.toString()));
    } else if (isSellToCurve) {
      signals.push(sig("WHALE_SELL_TO_CURVE", "MEDIUM", 75, `${amountStr} tokens sold into the curve in tx ${w.txHash}`, "A large sell went directly into the bonding curve.", now, w.blockNumber.toString()));
    } else if (!PROTOCOL_SET.has(to) && !PROTOCOL_SET.has(from)) {
      signals.push(sig("WHALE_TRANSFER", "LOW", 50, `${amountStr} tokens moved wallet-to-wallet in tx ${w.txHash}`, "A large wallet-to-wallet transfer was observed — direction/intent isn't inferred from this alone.", now, w.blockNumber.toString()));
    }
  }

  // --- Risk findings promoted to signals ---
  for (const f of risk.findings) {
    const type = RISK_CODE_TO_SIGNAL[f.code];
    if (!type) continue; // CLEAN and anything not in the map isn't signal-worthy alone
    signals.push(sig(type, f.level, 85, f.evidence, f.evidence, now));
  }

  // --- Trend signals: only with a real previous snapshot ---
  if (previousSnapshot) {
    const elapsedMinutes = Math.max(1 / 60, (now - previousSnapshot.takenAt) / 60);
    const trendConfidence = Math.round(Math.min(85, 40 + elapsedMinutes * 2));

    // A token that graduated between the two snapshots being compared has
    // an incompatible liquidity metric on each side (pre-graduation:
    // the curve's own balance; post-graduation: not read at all yet, see
    // chain/liquidity.ts) — comparing them would risk calling a legitimate
    // phase transition a "liquidity collapse". The null-check above the
    // liquidity block already prevents this in the common case (post-grad
    // liquidityUsd is null today), but this guard makes the rule explicit
    // and keeps it correct if a future provider starts returning a real
    // post-graduation number.
    const phaseChanged =
      previousSnapshot.graduated !== null && metrics.graduated !== null && previousSnapshot.graduated !== metrics.graduated;

    if (phaseChanged) {
      signals.push(
        sig(
          "PHASE_CHANGE",
          "MEDIUM",
          trendConfidence,
          metrics.graduated ? "graduated from the bonding curve to the AMM pool" : "reverted to curve (unexpected)",
          metrics.graduated
            ? "This token graduated to its post-curve trading pool since the last check."
            : "This token's phase changed since the last check.",
          now
        )
      );
    }

    if (metrics.holderCount !== null && previousSnapshot.holderCount !== null && previousSnapshot.holderCount > 0) {
      const delta = metrics.holderCount - previousSnapshot.holderCount;
      const pct = (delta / previousSnapshot.holderCount) * 100;
      if (delta > 0) {
        signals.push(
          sig(
            "HOLDER_GROWTH",
            pct >= 20 ? "HIGH" : pct >= 10 ? "MEDIUM" : "LOW",
            trendConfidence,
            `holders ${previousSnapshot.holderCount} → ${metrics.holderCount} (+${pct.toFixed(1)}%) over ${elapsedMinutes.toFixed(0)}m`,
            "Holder count increased since the last check.",
            now
          )
        );
      } else if (delta < 0) {
        signals.push(
          sig(
            "HOLDER_DECLINE",
            pct <= -20 ? "HIGH" : pct <= -10 ? "MEDIUM" : "LOW",
            trendConfidence,
            `holders ${previousSnapshot.holderCount} → ${metrics.holderCount} (${pct.toFixed(1)}%) over ${elapsedMinutes.toFixed(0)}m`,
            "Holder count decreased since the last check.",
            now
          )
        );
      }
    }

    if (!phaseChanged && metrics.liquidityUsd !== null && previousSnapshot.liquidityUsd !== null && previousSnapshot.liquidityUsd > 0) {
      const delta = metrics.liquidityUsd - previousSnapshot.liquidityUsd;
      const pct = (delta / previousSnapshot.liquidityUsd) * 100;
      if (Math.abs(pct) >= 10) {
        const type: SignalType = pct > 0 ? "LIQUIDITY_INCREASE" : "LIQUIDITY_DECREASE";
        signals.push(
          sig(
            type,
            Math.abs(pct) >= 30 ? "HIGH" : "MEDIUM",
            trendConfidence,
            `liquidity $${previousSnapshot.liquidityUsd.toFixed(0)} → $${metrics.liquidityUsd.toFixed(0)} (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%) over ${elapsedMinutes.toFixed(0)}m`,
            pct > 0 ? "Liquidity increased since the last check." : "Liquidity decreased since the last check.",
            now
          )
        );
      }
    }

    if (metrics.priceInPair !== null && previousSnapshot.priceInPair !== null && previousSnapshot.priceInPair > 0) {
      const pct = ((metrics.priceInPair - previousSnapshot.priceInPair) / previousSnapshot.priceInPair) * 100;
      if (Math.abs(pct) >= 5) {
        const type: SignalType = pct > 0 ? "PRICE_UP" : "PRICE_DOWN";
        signals.push(
          sig(
            type,
            Math.abs(pct) >= 20 ? "HIGH" : "MEDIUM",
            trendConfidence,
            `price ${pct > 0 ? "+" : ""}${pct.toFixed(1)}% over ${elapsedMinutes.toFixed(0)}m`,
            pct > 0 ? "Price moved up since the last check." : "Price moved down since the last check.",
            now
          )
        );
      }
    }

    const recentTx = metrics.buyCountWindow + metrics.sellCountWindow - (previousSnapshot.buyCountWindow + previousSnapshot.sellCountWindow);
    if (recentTx > 0) {
      const rate = recentTx / elapsedMinutes;
      const baselineRate = computeLifetimeBaselineRate(input.launchTimestamp, input.snapshotHistory, now);

      if (baselineRate !== null && recentTx >= 3) {
        // Real baseline available and trusted (see eligibility gate above)
        // — compare this token against its own history instead of a
        // fixed rate that means something different for a quiet token
        // than a genuinely popular one.
        const multiplier = rate / baselineRate;
        if (multiplier >= 2) {
          signals.push(
            sig(
              "ACTIVITY_ACCELERATION",
              multiplier >= 8 ? "HIGH" : multiplier >= 4 ? "MEDIUM" : "LOW",
              trendConfidence,
              `${recentTx} trades in the last ${elapsedMinutes.toFixed(0)}m (${rate.toFixed(1)}/min) — ${multiplier.toFixed(1)}x this token's own lifetime average of ${baselineRate.toFixed(2)}/min`,
              "Trading activity is running well above this token's own historical pace, not just the last check.",
              now
            )
          );
        }
      } else if (rate >= 0.5) {
        // Fallback: token too young / too little history for a trusted
        // baseline (see computeLifetimeBaselineRate) — same fixed
        // thresholds this always used, not a regression for that case.
        signals.push(
          sig(
            "ACTIVITY_ACCELERATION",
            rate >= 5 ? "HIGH" : rate >= 2 ? "MEDIUM" : "LOW",
            trendConfidence,
            `${recentTx} trades in the last ${elapsedMinutes.toFixed(0)}m (${rate.toFixed(1)}/min)`,
            "Trading activity picked up since the last check.",
            now
          )
        );
      }
    }
  }

  return signals;
}

function sig(
  type: SignalType,
  severity: Signal["severity"],
  confidence: number,
  evidence: string,
  explanation: string,
  timestamp: number,
  blockNumber?: string
): Signal {
  return { type, severity, confidence, evidence, explanation, timestamp, blockNumber };
}
