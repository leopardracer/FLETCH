import type { WalletIntelligence } from "../wallets/walletScore.js";
import { shortAddress } from "./brief.js";

/**
 * Deterministic fact list for one wallet, built only from
 * getWalletIntelligence()'s own output — the input to the AI wallet read
 * (rephraseFacts(..., "wallet")). Anything UNAVAILABLE / NOT_YET_IMPLEMENTED
 * is stated as such, with FLETCH's own reason, never smoothed over.
 */
const fmt = (n: number, digits = 4) => Number(n.toFixed(digits)).toString();

export function buildWalletFacts(w: WalletIntelligence): string[] {
  const facts: string[] = [];
  if (!w.profile && w.positions.length === 0) {
    return [`FLETCH has no recorded activity for wallet ${shortAddress(w.wallet)} yet.`];
  }
  if (w.profile) {
    facts.push(`FLETCH has seen wallet ${shortAddress(w.wallet)} touch ${w.profile.tokensTouched.length} token(s).`);
  }

  const counted = w.positions.filter((p) => p.status !== "UNKNOWN_COST_BASIS");
  const open = counted.filter((p) => p.status === "OPEN").length;
  const closed = counted.filter((p) => p.status === "CLOSED").length;
  const unknown = w.positions.length - counted.length;
  if (w.positions.length > 0) {
    facts.push(
      `Positions FLETCH saw from launch: ${open} open, ${closed} fully closed` +
        (unknown > 0 ? `, and ${unknown} excluded because the wallet sold tokens FLETCH never saw it buy.` : ".")
    );
  }

  const m = w.metrics;
  const line = (label: string, metric: WalletIntelligence["metrics"][keyof WalletIntelligence["metrics"]], render: (v: number) => string) => {
    if (metric.availability === "REAL" && typeof metric.value === "number") {
      facts.push(`${label}: ${render(metric.value)}.`);
    } else if (metric.availability !== "REAL") {
      facts.push(`${label}: unavailable — ${metric.reason ?? "no data"}.`);
    }
  };
  line("Realized PnL", m.realizedPnl, (v) => `${v >= 0 ? "+" : ""}${fmt(v)} ETH`);
  line("Unrealized PnL", m.unrealizedPnl, (v) => `${v >= 0 ? "+" : ""}${fmt(v)} ETH`);
  line("Win rate", m.winRate, (v) => `${fmt(v, 1)}% (${m.winRate.reason ?? ""})`);
  line("Entry timing", m.earlyEntryTiming, (v) => `median ${fmt(v, 1)} blocks after each token's launch`);
  return facts;
}
