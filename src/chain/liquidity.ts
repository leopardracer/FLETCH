import { formatUnits } from "viem";
import { getClient } from "./client.js";
import { getPairAssetUsdPrice } from "../core/price-feed.js";
import { readLaunchRecord, readCurveState, type LaunchRecord } from "./launch.js";
import { NATIVE_ETH, curveAbi } from "./pons.js";
import { config } from "../core/config.js";
import { fetchLogsInChunks, boundedScanStart } from "./logScan.js";
import { decodeCurveTrade } from "./curveTrades.js";
import { recordCurveScan } from "../persistence/walletTradesStore.js";

export interface LiquidityInfo {
  hasPool: boolean;
  source: "curve" | "none";
  poolAddress?: `0x${string}`;
  pairReserve: number | null;
  priceInPair: number | null;
  liquidityPairAsset: number | null;
  liquidityUsd: number | null;
  /** null = genuinely unknown (no launch record found, or the graduation
   *  check itself was bounded and found nothing within its window — see
   *  chain/launch.ts's CurveState). Never guessed either way. */
  graduated?: boolean | null;
  usdUnavailableReason?: string;
}

/**
 * Real pre-graduation pricing for any token, off its own Pons V2 bonding
 * curve.
 *
 * Post-graduation, a token trades in a Uniswap v4 pool. v4 has no
 * per-pool contract with getReserves() — pools live inside a shared
 * PoolManager singleton keyed by PoolId, and reading a live price needs
 * either a StateView/quoter call or an indexer (e.g. Bitquery, which
 * already decodes Robinhood Chain v4 trades). That is NOT implemented
 * here — this returns `graduated: true` with price/liquidity left null
 * rather than guessing. Wiring a Bitquery-backed ChainDataProvider
 * (see data/) is the fix — see data/types.ts.
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
      graduated: null,
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
    graduated: curve.graduated,
    usdUnavailableReason:
      liquidityPairAsset === null
        ? "pair asset is not native ETH — ERC-20 quote-asset balance reading isn't implemented yet"
        : usdPrice === null
        ? "USD price feed unavailable"
        : undefined,
  };
}

/**
 * Implied price from the curve's own most recent CurveBuy/CurveSell — a real
 * trade, not an estimate.
 *
 * Phase 4: the same logs this already fetches are also recorded as
 * per-wallet trades with their exact price-at-trade (persistence/
 * walletTradesStore.ts) — zero extra RPC calls. Only for native-ETH-paired
 * launches, so every recorded amount is in one known unit. A persistence
 * failure is logged and never breaks the price read itself.
 */
async function lastTradePrice(launch: LaunchRecord): Promise<number | null> {
  const client = getClient();
  const latest = await client.getBlockNumber();
  const { fromBlock } = boundedScanStart(launch.launchBlock, latest, true, config.maxHolderScanBlocks);
  const [buys, sells] = await Promise.all([
    fetchLogsInChunks(
      (r) => client.getLogs({ address: launch.curve, event: curveAbi[0], fromBlock: r.fromBlock, toBlock: r.toBlock }),
      fromBlock,
      latest,
      config.logScanChunkBlocks
    ),
    fetchLogsInChunks(
      (r) => client.getLogs({ address: launch.curve, event: curveAbi[1], fromBlock: r.fromBlock, toBlock: r.toBlock }),
      fromBlock,
      latest,
      config.logScanChunkBlocks
    ),
  ]);

  if (launch.pairToken.toLowerCase() === NATIVE_ETH) {
    try {
      const trades = [...buys, ...sells]
        .map((l) => decodeCurveTrade(l))
        .filter((t): t is NonNullable<typeof t> => t !== null);
      recordCurveScan(launch.token, Number(launch.launchBlock), Number(fromBlock), Number(latest), trades);
    } catch (e) {
      console.warn(`Recording curve trades for ${launch.token} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const all = [...buys, ...sells].sort((a, b) => Number(b.blockNumber! - a.blockNumber!));
  if (all.length === 0) return null;
  const last = decodeCurveTrade(all[0]);
  return last ? last.quoteAmount / last.tokenAmount : null;
}
