import { getDeadTokens } from "../monitoring/monitoringStore.js";
import { computeLifecycles, type SignalLifecycle } from "../signals/lifecycle.js";
import { getDistinctTokensWithRecentSignals, getSignalsForTokenSince } from "../persistence/signalsStore.js";
import { getLatestSnapshot, type TokenSnapshot } from "../persistence/snapshots.js";
import { readTokenInfo } from "../chain/token.js";
import { calculateRadarScore, explainRadar, RADAR_WINDOW_SECONDS_DEFAULT, type RadarResult } from "./radarEngine.js";
import type { RiskLevel } from "../risk/riskAnalysis.js";

export interface RadarEntry {
  token: `0x${string}`;
  symbol: string | null;
  name: string | null;
  radarScore: number;
  fletchScore: number | null;
  riskLevel: RiskLevel | null;
  topSignal: RadarResult["topSignal"];
  /** Where the top signal's type is in its lifecycle (signals/lifecycle.ts) — DETECTED, STRENGTHENING, ... */
  topSignalLifecycle: SignalLifecycle | null;
  whyNow: string[];
  distinctSignalTypes: number;
  convergenceMultiplier: number;
  lastSignalAt: number;
  /** A handful of the metrics behind the score — sourced from the token's
   *  latest persisted snapshot, not a fresh chain read (see docs/RADAR.md
   *  on why Radar doesn't need a live RPC call to rank). */
  metrics: {
    holderCount: number | null;
    liquidityUsd: number | null;
    buyCountWindow: number | null;
    sellCountWindow: number | null;
  };
  dataAvailability: {
    symbol: "REAL" | "UNAVAILABLE";
    fletchScore: "REAL" | "NOT_ENOUGH_HISTORY";
  };
}

/**
 * Meme Radar: ranks tokens by how much is changing right now, not by
 * size. Candidates come entirely from persistence — every field here
 * (except symbol/name) is read from the `signals` and `token_snapshots`
 * tables, no live chain call required to compute a ranking. Symbol/name
 * resolution still needs a chain read (best-effort, cached, degrades to
 * null the same way the rest of the app does without RPC_URL).
 */
export async function getRadar(windowSeconds: number = RADAR_WINDOW_SECONDS_DEFAULT, now: number = Math.floor(Date.now() / 1000)): Promise<RadarEntry[]> {
  const since = now - windowSeconds;
  const dead = getDeadTokens();
  const candidateTokens = getDistinctTokensWithRecentSignals(since).filter((t) => !dead.has(t.toLowerCase()));

  const entries = await Promise.all(
    candidateTokens.map(async (tokenLower) => {
      const token = tokenLower as `0x${string}`;
      const signals = getSignalsForTokenSince(token, since);
      const result = calculateRadarScore(signals, now, windowSeconds);
      if (!result) return null; // filtered again defensively — see radarEngine's own window filter

      const snapshot: TokenSnapshot | null = getLatestSnapshot(token);
      const lifecycle = computeLifecycles(getSignalsForTokenSince(token, now - 3 * windowSeconds), now, windowSeconds).find(
        (l) => l.type === result.topSignal.type
      ) ?? null;
      const info = await readTokenInfo(token).catch(() => null);

      const entry: RadarEntry = {
        token,
        symbol: info?.symbol ?? null,
        name: info?.name ?? null,
        radarScore: result.radarScore,
        fletchScore: snapshot?.fletchScore ?? null,
        riskLevel: snapshot?.riskLevel ?? null,
        topSignal: result.topSignal,
        topSignalLifecycle: lifecycle,
        whyNow: explainRadar(result),
        distinctSignalTypes: result.distinctSignalTypes,
        convergenceMultiplier: result.convergenceMultiplier,
        lastSignalAt: result.lastSignalAt,
        metrics: {
          holderCount: snapshot?.holderCount ?? null,
          liquidityUsd: snapshot?.liquidityUsd ?? null,
          buyCountWindow: snapshot?.buyCountWindow ?? null,
          sellCountWindow: snapshot?.sellCountWindow ?? null,
        },
        dataAvailability: {
          symbol: info?.symbol ? "REAL" : "UNAVAILABLE",
          fletchScore: snapshot?.fletchScore !== null && snapshot?.fletchScore !== undefined ? "REAL" : "NOT_ENOUGH_HISTORY",
        },
      };
      return entry;
    })
  );

  return entries
    .filter((e): e is RadarEntry => e !== null)
    .sort((a, b) => b.radarScore - a.radarScore);
}
