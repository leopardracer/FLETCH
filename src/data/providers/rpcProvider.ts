import { formatUnits } from "viem";
import { getClient } from "../../chain/client.js";
import { scanRecentLaunches } from "../../chain/hunt.js";
import { readTokenInfo } from "../../chain/token.js";
import { readLaunchRecord, readCurveState } from "../../chain/launch.js";
import { readHolderStats, topHolderConcentrationPercent } from "../../chain/holders.js";
import { readLiquidity } from "../../chain/liquidity.js";
import { erc20Abi } from "../../chain/token.js";
import { curveAbi } from "../../chain/pons.js";
import { config } from "../../core/config.js";
import { ImmutableCache } from "../../core/cache.js";
import { recordWalletActivity } from "../../persistence/walletActivityStore.js";
import type { ChainDataProvider, Token, TokenMetrics, Transfer, Holder, WalletActivity } from "../types.js";

const blockTimestampCache = new ImmutableCache<string, number>();
async function getBlockTimestamp(blockNumber: bigint): Promise<number | null> {
  try {
    return await blockTimestampCache.getOrCompute(blockNumber.toString(), async () => {
      const block = await getClient().getBlock({ blockNumber });
      return Number(block.timestamp);
    });
  } catch {
    return null;
  }
}

/**
 * Free-tier implementation: raw RPC + the Pons V2 factory/curve reads.
 * This is the "source of truth" provider — always correct, but O(logs)
 * per call, so it doesn't scale to computing metrics for hundreds of
 * tokens continuously. Good enough for the MVP's on-demand token-page and
 * small discovery-window use cases.
 *
 * A BlockscoutProvider (holders/tx acceleration) or a future Bitquery
 * provider (decoded trades, v4 pricing, cross-token wallet history) can
 * implement the same ChainDataProvider interface and be swapped in — see
 * data/providers/index.ts.
 */
export class RpcChainDataProvider implements ChainDataProvider {
  async getNewTokens(windowBlocks?: bigint): Promise<Token[]> {
    const launches = await scanRecentLaunches(windowBlocks);
    return Promise.all(
      launches.map(async (l) => {
        const timestamp = await getBlockTimestamp(l.launchBlock);
        const curveState = await readCurveState({
          found: true,
          token: l.token,
          curve: l.curve,
          deployer: l.deployer,
          pairToken: l.pairToken,
          launchConfigId: 0n,
          graduationThreshold: l.graduationThreshold,
          launchBlock: l.launchBlock,
          launchTxHash: l.launchTxHash,
        });
        return {
          address: l.token,
          symbol: null, // resolved lazily via getTokenMetrics/readTokenInfo when the token page is opened — avoids N extra RPC calls on every feed refresh
          name: null,
          deployer: l.deployer,
          launchBlock: l.launchBlock,
          launchTimestamp: timestamp,
          ageSeconds: timestamp ? Math.max(0, Math.floor(Date.now() / 1000) - timestamp) : null,
          graduated: curveState.graduated,
        } satisfies Token;
      })
    );
  }

  async getTokenMetrics(address: `0x${string}`): Promise<TokenMetrics> {
    const info = await readTokenInfo(address);
    const decimals = info.decimals;

    const [liquidity, holders] = await Promise.all([
      readLiquidity(address),
      readHolderStats(address, decimals).catch(() => null),
    ]);

    let buyCountWindow = 0;
    let sellCountWindow = 0;
    let volumePairAssetWindow: number | null = null;

    const launch = await readLaunchRecord(address);
    if (launch.found) {
      const client = getClient();
      const latest = await client.getBlockNumber();
      const [buys, sells] = await Promise.all([
        client.getLogs({ address: launch.curve, event: curveAbi[0], fromBlock: launch.launchBlock, toBlock: latest }),
        client.getLogs({ address: launch.curve, event: curveAbi[1], fromBlock: launch.launchBlock, toBlock: latest }),
      ]);
      buyCountWindow = buys.length;
      sellCountWindow = sells.length;
      const buyVol = buys.reduce((s, b) => s + Number(formatUnits((b.args as any).quoteIn, 18)), 0);
      const sellVol = sells.reduce((s, b) => s + Number(formatUnits((b.args as any).quoteOut, 18)), 0);
      volumePairAssetWindow = buyVol + sellVol;
    }

    return {
      priceInPair: liquidity.priceInPair,
      liquidityPairAsset: liquidity.liquidityPairAsset,
      liquidityUsd: liquidity.liquidityUsd,
      liquidityUsdUnavailableReason: liquidity.usdUnavailableReason,
      holderCount: holders?.holderCount ?? null,
      holderCountIsLifetime: holders?.isLifetime ?? false,
      buyCountWindow,
      sellCountWindow,
      volumePairAssetWindow,
      topHolderConcentrationPercent: holders ? topHolderConcentrationPercent(holders, 10) : null,
      whaleMoves: (holders?.whaleMoves ?? []).map((w) => ({
        from: w.from as `0x${string}`,
        to: w.to as `0x${string}`,
        amount: w.amount,
        txHash: w.txHash as `0x${string}`,
        blockNumber: BigInt(w.blockNumber),
      })),
    };
  }

  async getTransfers(address: `0x${string}`): Promise<Transfer[]> {
    const client = getClient();
    const info = await readTokenInfo(address);
    const launch = await readLaunchRecord(address);
    const latest = await client.getBlockNumber();
    const fromBlock = launch.found ? launch.launchBlock : latest > config.signalWindowBlocks ? latest - config.signalWindowBlocks : 0n;

    const logs = await client.getLogs({ address, event: erc20Abi[0], fromBlock, toBlock: latest });
    return logs.map((log) => {
      const { from, to, value } = log.args as { from: `0x${string}`; to: `0x${string}`; value: bigint };
      return {
        from,
        to,
        amount: Number(formatUnits(value, info.decimals)),
        txHash: log.transactionHash!,
        blockNumber: log.blockNumber!,
      };
    });
  }

  async getHolders(address: `0x${string}`): Promise<Holder[]> {
    const info = await readTokenInfo(address);
    const stats = await readHolderStats(address, info.decimals);
    return stats.topAccumulators
      .filter((h) => h.netChange > 0)
      .map((h) => ({ address: h.address as `0x${string}`, balance: h.netChange }));
  }

  /**
   * Honest limitation: with no persistence layer, "wallet activity" here is
   * scoped to net accumulation within THIS token's own scan window — not a
   * cross-token trading history. Real win-rate / early-entry smart-money
   * tracking needs either a database that accumulates history over time or
   * an indexer (Bitquery) that already has it — see wallets/smartMoney.ts,
   * which returns UNAVAILABLE rather than pretending this data answers that.
   */
  async getWalletActivity(address: `0x${string}`): Promise<WalletActivity[]> {
    const [holders, metrics] = await Promise.all([this.getHolders(address), this.getTokenMetrics(address).catch(() => null)]);
    for (const h of holders) {
      recordWalletActivity(h.address, address, h.balance, metrics?.priceInPair ?? null);
    }
    return holders.map((h) => ({
      wallet: h.address,
      tokensTraded: 1,
      note: "scoped to this token's own scan window only — no cross-token history available yet",
    }));
  }
}
