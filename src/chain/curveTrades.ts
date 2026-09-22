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
