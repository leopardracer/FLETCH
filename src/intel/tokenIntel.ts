import { config } from "../core/config.js";
import type { TokenInfo } from "../chain/token.js";
import type { RpcChainDataProvider } from "../data/providers/rpcProvider.js";
import { scanRecentLaunches } from "../chain/hunt.js";
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

  const launches = await scanRecentLaunches(50_000n);
  const launch = launches.find((l) => l.token.toLowerCase() === address.toLowerCase()) ?? null;

  const smartMoney = await getSmartMoneyForToken(address);
  const social = await getSocialSignalForToken(address);
  const { risk, score, signals } = analyzeAndPersist(address, launch, metrics, smartMoney, social);
  const whyIsItMoving = explainWhyItsMoving(signals, risk);

  return {
    token: { address, symbol: info.symbol, name: info.name, contractExists: info.contractExists },
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
