import { SEVERITY_RANK, pickTopSignal, type Signal, type SignalSeverity, type SignalType } from "../signals/types.js";

/**
 * Meme Radar answers a different question than the FLETCH Score.
 *
 * FLETCH Score: "how healthy/interesting is this token based on its
 *   current metrics?" — see scoring/fletchScore.ts. Unchanged by this file.
 *
 * Radar: "how unusual and important is the change happening RIGHT NOW?"
 *   — built entirely from real, already-detected signals (signals/signalEngine.ts)
 *   within a recency window. A token with zero recent signals is not a
 *   radar candidate at all — see calculateRadarScore's null return.
 */

/** How far back a signal still counts at all. Past this, recency = 0 and
 *  the signal contributes nothing — not because it's deleted, just because
 *  Radar answers "right now," not "ever." */
export const RADAR_WINDOW_SECONDS_DEFAULT = 1800; // 30 minutes

/** Per-severity ceiling on a single signal's contribution, before recency
 *  and confidence scale it down and before the convergence multiplier is
 *  applied. Deliberately left short of 100 so that convergence (multiple
 *  distinct signal types firing at once) can meaningfully push a token
 *  higher than any single signal could alone — see CONVERGENCE_STEPS. */
const SEVERITY_MAGNITUDE: Record<SignalSeverity, number> = {
  LOW: 15,
  MEDIUM: 35,
  HIGH: 60,
  CRITICAL: 85,
};

/** Index by (distinct signal type count - 1), clamped to the last step.
 *  1 type: no bonus. 2: +15%. 3: +30%. 4+: +45%. Simple, discrete, and
 *  stated exactly like this in docs/RADAR.md — no hidden curve-fitting. */
const CONVERGENCE_STEPS = [1, 1.15, 1.3, 1.45];

export interface RadarContribution {
  type: SignalType;
  severity: SignalSeverity;
  /** This type's contribution to the score, after recency + confidence, before the convergence multiplier. */
  magnitude: number;
  /** The real explanation text of the signal that produced this contribution — never rewritten. */
  explanation: string;
  evidence: string;
  timestamp: number;
}

export interface RadarResult {
  radarScore: number; // 0-100
  distinctSignalTypes: number;
  convergenceMultiplier: number;
  /** The most severe signal in the window, for a one-line UI badge. */
  topSignal: Signal;
  /** One entry per distinct signal type that contributed — the real basis for "why now." */
  contributions: RadarContribution[];
  /** Unix seconds of the most recent contributing signal — Radar's own recency stamp. */
  lastSignalAt: number;
}

/**
 * Pure function: same signals, same `now`, same result, every time. No
 * chain calls, no DB access — src/radar/radarService.ts is the impure
 * layer that fetches signals and calls this.
 *
 * Returns null when there are no signals in the window at all — a quiet
 * token is not a radar candidate, not a radar score of 0. This is also
 * how new launches with zero activity stay off Radar (see docs/RADAR.md).
 */
export function calculateRadarScore(
  signalsInWindow: Signal[],
  now: number,
  windowSeconds: number = RADAR_WINDOW_SECONDS_DEFAULT
): RadarResult | null {
  // Filtered here too, not just trusted from the caller — a signal outside
  // the window contributes a recency of 0 either way, but leaving it in
  // would still count its *type* toward distinctSignalTypes and topSignal,
  // misrepresenting what's actually happening right now. Caught by
  // radarEngine.test.ts.
  const inWindow = signalsInWindow.filter((s) => now - s.timestamp <= windowSeconds);
  if (inWindow.length === 0) return null;

  // Keep only the single most severe instance per distinct signal type —
  // this is what makes Radar reward *convergence* (several different
  // things happening at once) rather than *volume* (the same signal type
  // firing repeatedly, which would otherwise let one noisy signal farm
  // the score just by recurring).
  const strongestByType = new Map<SignalType, Signal>();
  for (const s of inWindow) {
    const existing = strongestByType.get(s.type);
    if (!existing || SEVERITY_RANK[s.severity] < SEVERITY_RANK[existing.severity]) {
      strongestByType.set(s.type, s);
    }
  }

  const contributions: RadarContribution[] = [];
  for (const s of strongestByType.values()) {
    const age = Math.max(0, now - s.timestamp);
    const recency = Math.max(0, 1 - age / windowSeconds);
    const magnitude = SEVERITY_MAGNITUDE[s.severity] * recency * (s.confidence / 100);
    contributions.push({ type: s.type, severity: s.severity, magnitude, explanation: s.explanation, evidence: s.evidence, timestamp: s.timestamp });
  }

  const distinctSignalTypes = contributions.length;
  const convergenceMultiplier = CONVERGENCE_STEPS[Math.min(distinctSignalTypes - 1, CONVERGENCE_STEPS.length - 1)];
  const sum = contributions.reduce((s, c) => s + c.magnitude, 0);
  const radarScore = Math.max(0, Math.min(100, Math.round(sum * convergenceMultiplier)));

  contributions.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.magnitude - a.magnitude);

  return {
    radarScore,
    distinctSignalTypes,
    convergenceMultiplier,
    topSignal: pickTopSignal(inWindow)!,
    contributions,
    lastSignalAt: Math.max(...inWindow.map((s) => s.timestamp)),
  };
}

/**
 * "Why now" — one real sentence per distinct contributing signal type,
 * most severe first. Never merged into a single invented narrative
 * ("X while Y and Z") since that would assert a relationship between
 * signals that was never actually verified — just the real, individual
 * explanation each signal already carries. If only one signal exists,
 * this returns exactly one sentence.
 */
export function explainRadar(result: RadarResult): string[] {
  return result.contributions.map((c) => c.explanation);
}
