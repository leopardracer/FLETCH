import { config } from "./config.js";

let cached: { price: number; at: number } | null = null;
const TTL_MS = 60_000;

/** Real external data (CoinGecko public API). Callers must handle `null`
 *  by showing DATA UNAVAILABLE, never silently treating it as zero. */
export async function getPairAssetUsdPrice(): Promise<number | null> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.price;

  try {
    const id = config.pairAssetCoingeckoId;
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, { usd?: number }>;
    const price = data[id]?.usd;
    if (typeof price !== "number") return null;
    cached = { price, at: Date.now() };
    return price;
  } catch {
    return null;
  }
}
