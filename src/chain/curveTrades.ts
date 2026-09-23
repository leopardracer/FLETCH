import { formatUnits } from "viem";
import type { CurveTrade } from "../persistence/walletTradesStore.js";

/**
 * Decodes one CurveBuy / CurveSell log (see chain/pons.ts's curveAbi) into
 * a wallet-attributed trade with its exact amounts.
 *
 * Attribution is to the event's `recipient` for both sides: on a buy that's
 * the wallet the tokens were sent to, on a sell the wallet the pair asset
 * was sent to — i.e. whoever actually holds the position, even when the
 * trade was routed through the Pons router (where `buyer`/`seller` is the
 * router contract, not a person). Returns null for anything that isn't a
 * well-formed curve trade — never a trade with a guessed field.
 */
export interface CurveLogLike {
  args: unknown;
  transactionHash: `0x${string}` | null;
  logIndex: number | null;
  blockNumber: bigint | null;
}

export function decodeCurveTrade(log: CurveLogLike, tokenDecimals = 18, quoteDecimals = 18): CurveTrade | null {
  if (log.transactionHash === null || log.logIndex === null || log.blockNumber === null) return null;
  const a = log.args as Record<string, unknown>;
  const recipient = a.recipient;
  if (typeof recipient !== "string" || !recipient.startsWith("0x")) return null;
  const base = {
    wallet: recipient as `0x${string}`,
    txHash: log.transactionHash,
    logIndex: log.logIndex,
    blockNumber: Number(log.blockNumber),
  };
  if (typeof a.quoteIn === "bigint" && typeof a.tokensOut === "bigint") {
    if (a.tokensOut <= 0n) return null;
    return {
      ...base,
      side: "buy",
      tokenAmount: Number(formatUnits(a.tokensOut, tokenDecimals)),
      quoteAmount: Number(formatUnits(a.quoteIn, quoteDecimals)),
    };
  }
  if (typeof a.quoteOut === "bigint" && typeof a.tokensIn === "bigint") {
    if (a.tokensIn <= 0n) return null;
    return {
      ...base,
      side: "sell",
      tokenAmount: Number(formatUnits(a.tokensIn, tokenDecimals)),
      quoteAmount: Number(formatUnits(a.quoteOut, quoteDecimals)),
    };
  }
  return null;
}

/**
 * Re-attributes curve trades to the wallet the tokens actually reached (buy)
 * or came from (sell), using the token's own Transfer flow in the same tx
 * with pass-through contracts already collapsed (chain/holders.ts).
 *
 * Found live: one intermediary contract (0x6505…) was credited with 115 of
 * 1,147 recorded trades, because the curve event's `recipient` is whatever
 * contract called it, not the person. Those wallets' own positions came up
 * empty. A buy now goes to the final token receiver; a sell to the original
 * token sender. When the flow doesn't identify one wallet unambiguously, the
 * event's recipient is kept — never a guess.
 */
export function attributeByTokenFlow(
  trades: CurveTrade[],
  flows: { from: string; to: string; amount: number; txHash: string }[],
  curve: string
): CurveTrade[] {
  const c = curve.toLowerCase();
  const byTx = new Map<string, typeof flows>();
  for (const f of flows) (byTx.get(f.txHash.toLowerCase()) ?? byTx.set(f.txHash.toLowerCase(), []).get(f.txHash.toLowerCase())!).push(f);
  const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-6);
  return trades.map((t) => {
    const fl = byTx.get(t.txHash.toLowerCase()) ?? [];
    const cands =
      t.side === "buy"
        ? fl.filter((f) => f.from.toLowerCase() === c && f.to.toLowerCase() !== c)
        : fl.filter((f) => f.to.toLowerCase() === c && f.from.toLowerCase() !== c);
    const exact = cands.filter((f) => close(f.amount, t.tokenAmount));
    const pick = exact.length === 1 ? exact[0] : cands.length === 1 ? cands[0] : null;
    if (!pick) return t;
    const wallet = (t.side === "buy" ? pick.to : pick.from) as `0x${string}`;
    return wallet.toLowerCase() === t.wallet.toLowerCase() ? t : { ...t, wallet };
  });
}
