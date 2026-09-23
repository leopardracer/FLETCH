import { config } from "../core/config.js";
import type { TokenInfo } from "../chain/token.js";
import type { RpcChainDataProvider } from "../data/providers/rpcProvider.js";
import { scanRecentLaunches, type DetectedLaunch } from "../chain/hunt.js";
import { getMonitoredToken } from "../monitoring/monitoringStore.js";
import { saveReport } from "../persistence/reportStore.js";
import { getSmartMoneyForToken } from "../wallets/smartMoney.js";
import { getSocialSignalForToken } from "../social/social.js";
import { analyzeAndPersist } from "../signals/signalService.js";
import { explainWhyItsMoving } from "../ai/explain.js";
import type { RiskReport } from "../risk/riskAnalysis.js";
import type { FletchScore } from "../scoring/fletchScore.js";
import type { Signal } from "../signals/types.js";
import type { WhyIsItMoving } from "../ai/explain.js";
import type { SmartMoneyReport } from "../wallets/smartMoney.js";
import type { SocialReport } from "../social/social.js";
import type { TokenMetrics } from "../data/types.js";

export type DataAvailability = "REAL" | "UNAVAILABLE" | "NOT_YET_IMPLEMENTED" | "REQUIRES_API_KEY";

export interface TokenIntel {
  token: { address: `0x${string}`; symbol: string | null; name: string | null; contractExists: boolean };
  /** "DEAD" when monitoring judged the launch drained and inactive (monitoring/deadToken.ts). */
  status?: "DEAD";
  metrics: TokenMetrics;
  risk: RiskReport;
  fletchScore: FletchScore;
  signals: Signal[];
  whyIsItMoving: WhyIsItMoving;
  smartMoney: SmartMoneyReport;
  social: SocialReport;
  dataAvailability: {
    liquidity: DataAvailability;
    holders: DataAvailability;
    whaleActivity: DataAvailability;
    smartMoney: DataAvailability;
    social: DataAvailability;
    postGraduationPricing: DataAvailability;
    blockscoutAcceleration: DataAvailability;
  };
}

/**
 * Builds the full FLETCH report for one token: metrics, risk, score,
 * signals, and the deterministic "why is it moving" explanation.
 *
 * This is the single place that assembly happens — extracted from
 * api/server.ts's GET /api/tokens/:address handler so the HTTP route and
 * the chat agent's get_token_report tool (src/ai/chatAgent.ts) call the
 * exact same code path instead of two copies that could drift apart.
 * Caller is responsible for the contractExists check (see server.ts) —
 * this assumes `info.contractExists` is already true.
 */
export async function getTokenIntel(
  address: `0x${string}`,
  info: TokenInfo,
  provider: RpcChainDataProvider
): Promise<TokenIntel> {
  const metrics = await provider.getTokenMetrics(address);
  // The monitoring queue already stored this token's launch record — reuse it
  // instead of re-scanning (and re-enriching) every launch in the window.
  const launch =
    getMonitoredToken(address)?.launch ?? (await scanRecentLaunches(50_000n, undefined, address))[0] ?? null;
  const smartMoney = await getSmartMoneyForToken(address);
  const social = await getSocialSignalForToken(address);
  const intel = buildIntel(address, info, launch, metrics, smartMoney, social);
  saveReport(address, intel);
  return intel;
}

/** Assembles (and persists signals for) a report from data already read — no chain reads here. */
export function buildIntel(
  address: `0x${string}`,
  info: Pick<TokenInfo, "symbol" | "name" | "contractExists">,
  launch: DetectedLaunch | null,
  metrics: TokenMetrics,
  smartMoney: SmartMoneyReport,
  social: SocialReport,
  now?: number,
  opts: { dead?: boolean } = {}
): TokenIntel {
  // A dead token still gets an honest report, but its repeat "liquidity is
  // only $0" signals are not re-filed on every check.
  const { risk, score, signals } = analyzeAndPersist(address, launch, metrics, smartMoney, social, now, { persistSignals: !opts.dead });
  const whyIsItMoving = explainWhyItsMoving(signals, risk);

  return {
    token: { address, symbol: info.symbol, name: info.name, contractExists: info.contractExists },
    ...(opts.dead ? { status: "DEAD" as const } : {}),
    metrics,
    risk,
    fletchScore: score,
    signals,
    whyIsItMoving,
    smartMoney,
    social,
    dataAvailability: {
      liquidity: metrics.liquidityUsd !== null ? "REAL" : "UNAVAILABLE",
      holders: metrics.holderCount !== null ? "REAL" : "UNAVAILABLE",
      whaleActivity: metrics.holderCount !== null ? "REAL" : "UNAVAILABLE",
      smartMoney: smartMoney.available ? "REAL" : "NOT_YET_IMPLEMENTED",
      social: social.available ? "REAL" : "NOT_YET_IMPLEMENTED",
      postGraduationPricing: "NOT_YET_IMPLEMENTED",
      blockscoutAcceleration: config.hasBlockscout() ? "REAL" : "REQUIRES_API_KEY",
    },
  };
}
