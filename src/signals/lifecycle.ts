import type { Signal, SignalSeverity, SignalType } from "./types.js";
import { SEVERITY_RANK } from "./types.js";

/**
 * Signal lifecycle — DETECTED → STRENGTHENING / STEADY → FADING → RESOLVED.
 *
 * Derived at read time from the signal rows FLETCH already persists (no new
 * table, no new chain reads): for each signal type on a token, compare the
 * most recent window against the one before it.
 *
 *  - DETECTED       fired in the recent window, not in the previous one (new, or back after a gap)
 *  - STRENGTHENING  fired more often than in the previous window, or at a higher severity
 *  - STEADY         fired about as often as before
 *  - FADING         fired less often than before, or not in the recent window but within 3 windows
 *  - RESOLVED       nothing for 3+ windows
 *
 * Purely descriptive of what already happened — a STRENGTHENING signal is
 * "happening more than it was", never a prediction that it will continue.
 */
export type LifecycleStage = "DETECTED" | "STRENGTHENING" | "STEADY" | "FADING" | "RESOLVED";

export interface SignalLifecycle {
  type: SignalType;
  stage: LifecycleStage;
  recentCount: number;
  previousCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
  peakSeverityRecent: SignalSeverity | null;
}

function peak(signals: Signal[]): SignalSeverity | null {
  if (signals.length === 0) return null;
  return signals.reduce((best, s) => (SEVERITY_RANK[s.severity] < SEVERITY_RANK[best] ? s.severity : best), signals[0].severity);
}

export function computeLifecycles(signals: Signal[], now: number, windowSeconds: number): SignalLifecycle[] {
  const byType = new Map<SignalType, Signal[]>();
  for (const s of signals) {
    if (s.timestamp > now) continue;
    const list = byType.get(s.type) ?? [];
    list.push(s);
    byType.set(s.type, list);
  }

  const out: SignalLifecycle[] = [];
  for (const [type, list] of byType) {
    const recent = list.filter((s) => now - s.timestamp < windowSeconds);
    const previous = list.filter((s) => now - s.timestamp >= windowSeconds && now - s.timestamp < 2 * windowSeconds);
    const lastSeenAt = Math.max(...list.map((s) => s.timestamp));
    const firstSeenAt = Math.min(...list.map((s) => s.timestamp));
    const peakRecent = peak(recent);
    const peakPrevious = peak(previous);

    let stage: LifecycleStage;
    if (recent.length > 0) {
      if (previous.length === 0) stage = "DETECTED";
      else if (
        recent.length > previous.length ||
        (peakRecent !== null && peakPrevious !== null && SEVERITY_RANK[peakRecent] < SEVERITY_RANK[peakPrevious])
      )
        stage = "STRENGTHENING";
      else if (recent.length === previous.length) stage = "STEADY";
      else stage = "FADING";
    } else {
      stage = now - lastSeenAt < 3 * windowSeconds ? "FADING" : "RESOLVED";
    }

    out.push({ type, stage, recentCount: recent.length, previousCount: previous.length, firstSeenAt, lastSeenAt, peakSeverityRecent: peakRecent });
  }

  const order: Record<LifecycleStage, number> = { STRENGTHENING: 0, DETECTED: 1, STEADY: 2, FADING: 3, RESOLVED: 4 };
  return out.sort((a, b) => order[a.stage] - order[b.stage] || b.lastSeenAt - a.lastSeenAt);
}
