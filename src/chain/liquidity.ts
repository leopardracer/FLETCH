import { formatUnits } from "viem";
import { getClient } from "./client.js";
import { getPairAssetUsdPrice } from "../core/price-feed.js";
import { readLaunchRecord, readCurveState, type LaunchRecord } from "./launch.js";
import { NATIVE_ETH, curveAbi } from "./pons.js";

export interface LiquidityInfo {
  hasPool: boolean;
  source: "curve" | "none";
  poolAddress?: `0x${string}`;
  pairReserve: number | null;
  priceInPair: number | null;
  liquidityPairAsset: number | null;
  liquidityUsd: number | null;
  graduated?: boolean;
  usdUnavailableReason?: string;
}

/**
 * Generalized from GTTM/src/chain/liquidity.ts (was single-token). Real
 * pre-graduation pricing off the token's own Pons V2 bonding curve.
 *
 * Post-graduation, a token trades in a Uniswap v4 pool. v4 has no
 * per-pool contract with getReserves() — pools live inside a shared
 * PoolManager singleton keyed by PoolId, and reading a live price needs
 * either a StateView/quoter call or an indexer (e.g. Bitquery, which
 * already decodes Robinhood Chain v4 trades). That is NOT implemented
 * here — this returns `graduated: true` with price/liquidity left null
 * rather than guessing, exactly as GTTM did. Wiring a Bitquery-backed
 * ChainDataProvider (see data/) is the fix — see data/types.ts.
 */
export async function readLiquidity(tokenAddress: `0x${string}`): Promise<LiquidityInfo> {
  const launch = await readLaunchRecord(tokenAddress);
  if (!launch.found) {
    return {
      hasPool: false,
      source: "none",
      pairReserve: null,
      priceInPair: null,
      liquidityPairAsset: null,
      liquidityUsd: null,
      usdUnavailableReason: launch.reason,
    };
  }

  const curve = await readCurveState(launch);

  if (curve.graduated) {
    return {
      hasPool: false,
      source: "none",
      pairReserve: null,
      priceInPair: null,
      liquidityPairAsset: null,
      liquidityUsd: null,
      graduated: true,
      usdUnavailableReason:
        "token has graduated to a Uniswap v4 pool — reading v4 pool state needs a " +
        "StateView/quoter call or an indexer this MVP doesn't wire up yet",
    };
  }

  let liquidityPairAsset: number | null = null;
  if (launch.pairToken.toLowerCase() === NATIVE_ETH) {
    const balance = await getClient().getBalance({ address: launch.curve });
    liquidityPairAsset = Number(formatUnits(balance, 18));
  }

  const priceInPair = await lastTradePrice(launch);
  const usdPrice = await getPairAssetUsdPrice();
  const liquidityUsd = liquidityPairAsset !== null && usdPrice !== null ? liquidityPairAsset * usdPrice : null;

  return {
    hasPool: true,
    source: "curve",
    poolAddress: launch.curve,
    pairReserve: liquidityPairAsset,
    priceInPair,
    liquidityPairAsset,
    liquidityUsd,
    graduated: false,
    usdUnavailableReason:
      liquidityPairAsset === null
        ? "pair asset is not native ETH — ERC-20 quote-asset balance reading isn't implemented yet"
        : usdPrice === null
        ? "USD price feed unavailable"
        : undefined,
  };
}

/** Implied price from the curve's own most recent CurveBuy/CurveSell — a real trade, not an estimate. */
async function lastTradePrice(launch: LaunchRecord): Promise<number | null> {
  const client = getClient();
  const latest = await client.getBlockNumber();
  const [buys, sells] = await Promise.all([
    client.getLogs({ address: launch.curve, event: curveAbi[0], fromBlock: launch.launchBlock, toBlock: latest }),
    client.getLogs({ address: launch.curve, event: curveAbi[1], fromBlock: launch.launchBlock, toBlock: latest }),
  ]);
  const all = [...buys, ...sells].sort((a, b) => Number(b.blockNumber! - a.blockNumber!));
  if (all.length === 0) return null;
  const last = all[0];
  const args = last.args as any;
  if ("quoteIn" in args && args.tokensOut > 0n) return Number(formatUnits(args.quoteIn, 18)) / Number(formatUnits(args.tokensOut, 18));
  if ("quoteOut" in args && args.tokensIn > 0n) return Number(formatUnits(args.quoteOut, 18)) / Number(formatUnits(args.tokensIn, 18));
  return null;
}
