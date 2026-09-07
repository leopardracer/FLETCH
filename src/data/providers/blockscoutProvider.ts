import { config } from "../../core/config.js";

/**
 * Optional accelerator for the free-tier RPC provider. Blockscout is
 * Robinhood Chain's official explorer (robinhoodchain.blockscout.com) with
 * a PRO API at api.blockscout.com keyed by chain_id=4663. A free key comes
 * from https://dev.blockscout.com.
 *
 * IMPORTANT — unverified against a live key: I could not obtain a
 * Blockscout API key in this environment to confirm the exact response
 * shape of the standard v2 token-counters/holders endpoints, so this is
 * written against Blockscout's documented v2 API conventions but has not
 * been exercised against real Robinhood Chain data. Every function here
 * fails soft (returns null) rather than throwing, so a wrong assumption
 * degrades to the RPC fallback instead of breaking the app — but treat
 * this file as needing a real smoke test against your own API key before
 * you trust it in production. Do not remove the fallback path in
 * rpcProvider.ts on the assumption this works.
 */

function apiBase(): string {
  return config.blockscoutApiBase.replace(/\/$/, "");
}

function headers(): Record<string, string> {
  return config.blockscoutApiKey ? { Authorization: `Bearer ${config.blockscoutApiKey}` } : {};
}

/** Fast holder count via Blockscout's token counters endpoint, instead of a full Transfer-log replay. */
export async function getHolderCountFast(tokenAddress: `0x${string}`): Promise<number | null> {
  if (!config.hasBlockscout()) return null;
  try {
    const url = `${apiBase()}/api/v2/tokens/${tokenAddress}/counters?chain_id=${config.chainId}`;
    const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { token_holders_count?: string | number };
    const raw = data.token_holders_count;
    if (raw === undefined) return null;
    const n = typeof raw === "string" ? parseInt(raw, 10) : raw;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Recent token transfers via Blockscout, instead of a raw getLogs scan — useful once history exceeds a comfortable RPC window. */
export async function getRecentTransfersFast(
  tokenAddress: `0x${string}`
): Promise<{ from: string; to: string; value: string; txHash: string; blockNumber: number }[] | null> {
  if (!config.hasBlockscout()) return null;
  try {
    const url = `${apiBase()}/api/v2/tokens/${tokenAddress}/transfers?chain_id=${config.chainId}`;
    const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { items?: any[] };
    if (!data.items) return null;
    return data.items.map((t) => ({
      from: t.from?.hash ?? t.from,
      to: t.to?.hash ?? t.to,
      value: t.total?.value ?? t.value,
      txHash: t.tx_hash ?? t.transaction_hash,
      blockNumber: t.block_number ?? t.block,
    }));
  } catch {
    return null;
  }
}
