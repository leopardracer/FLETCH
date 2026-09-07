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
