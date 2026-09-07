export type SignalType =
  | "BUY_PRESSURE"
  | "SELL_PRESSURE"
  | "WHALE_BUY_FROM_CURVE"
  | "WHALE_SELL_TO_CURVE"
  | "WHALE_TRANSFER"
  | "HOLDER_GROWTH"
  | "HOLDER_DECLINE"
  | "LIQUIDITY_INCREASE"
  | "LIQUIDITY_DECREASE"
  | "ACTIVITY_ACCELERATION"
  | "PRICE_UP"
  | "PRICE_DOWN"
  | "DEPLOYER_RISK"
  | "BUNDLED_WALLETS"
  | "SERIAL_DEPLOYER"
  | "HOLDER_CONCENTRATION"
  | "THIN_LIQUIDITY";

export type SignalSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface Signal {
  type: SignalType;
  severity: SignalSeverity;
  /** 0-100. Not a statistical confidence interval — a deterministic tier
   *  tied to how much real data backs the signal. See docs/SIGNALS.md. */
  confidence: number;
  /** The specific number(s) behind the signal — never a vague label. */
  evidence: string;
  /** Human-readable sentence, built only from `evidence`. */
  explanation: string;
  blockNumber?: string;
  timestamp: number; // unix seconds
}

export const SEVERITY_RANK: Record<SignalSeverity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

/**
 * The single most severity-worthy signal from a batch, for UI contexts
 * that can only show one (a feed row, an overview card) — never just
 * "the first one detected," which is an arbitrary code-order artifact,
 * not a ranking. Ties keep their relative detection order (stable sort).
 */
export function pickTopSignal(signals: Signal[]): Signal | null {
  if (signals.length === 0) return null;
  return [...signals].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])[0];
}
