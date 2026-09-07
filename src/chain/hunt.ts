import { formatUnits } from "viem";
import { getClient } from "./client.js";
import { config } from "../core/config.js";
import { PONS_V2_FACTORY, factoryAbi, curveAbi, SOLD_ON_CURVE_SUPPLY } from "./pons.js";

export interface DetectedLaunch {
  token: `0x${string}`;
  curve: `0x${string}`;
  deployer: `0x${string}`;
  pairToken: `0x${string}`;
  graduationThreshold: bigint;
  launchBlock: bigint;
  launchTxHash: `0x${string}`;
  devBuyTokens: number | null;
  devBuyTaxBps: number | null;
  exemptWalletCount: number;
  deployerLaunchCountInWindow: number;
}

/**
 * Scans the Pons V2 factory for every TokenLaunched event in a recent block
 * window — FLETCH's "new token" feed. This is chain-wide already (not
 * scoped to one token), ported near-verbatim from GTTM's sniper engine
 * (GTTM/src/chain/hunt.ts). Every field is a real chain read or a count
 * derived from one — nothing here is guessed.
 */
export async function scanRecentLaunches(windowBlocks?: bigint): Promise<DetectedLaunch[]> {
  const client = getClient();
  const latest = await client.getBlockNumber();
  const window = windowBlocks ?? config.signalWindowBlocks;
  const fromBlock = latest > window ? latest - window : 0n;

  const launchLogs = await client.getLogs({
    address: PONS_V2_FACTORY,
    event: factoryAbi[0], // TokenLaunched
    fromBlock,
    toBlock: latest,
  });

  const deployerCounts = new Map<string, number>();
  for (const log of launchLogs) {
    const deployer = (log.args as any).deployer as string;
    deployerCounts.set(deployer, (deployerCounts.get(deployer) ?? 0) + 1);
  }

  const results: DetectedLaunch[] = [];

  for (const log of launchLogs) {
    const args = log.args as {
      token: `0x${string}`;
      curve: `0x${string}`;
      deployer: `0x${string}`;
      pairToken: `0x${string}`;
      launchConfigId: bigint;
      graduationThreshold: bigint;
    };

    const [buyLogsInTx, exemptLogsInTx] = await Promise.all([
      client.getLogs({
        address: args.curve,
        event: curveAbi[0], // CurveBuy
        fromBlock: log.blockNumber!,
        toBlock: log.blockNumber!,
      }),
      client.getLogs({
        address: args.curve,
        event: { type: "event", name: "SnipeTaxExempted", inputs: [{ name: "account", type: "address", indexed: true }] },
        fromBlock: log.blockNumber!,
        toBlock: log.blockNumber!,
      }),
    ]);

    const devBuy = buyLogsInTx.find((b) => b.transactionHash === log.transactionHash);
    let devBuyTokens: number | null = null;
    let devBuyTaxBps: number | null = null;
    if (devBuy) {
      const b = devBuy.args as any;
      devBuyTokens = Number(formatUnits(b.tokensOut, 18));
      if (b.quoteIn > 0n) devBuyTaxBps = Number((b.tax * 10000n) / b.quoteIn);
    }

    const exemptInThisTx = exemptLogsInTx.filter((e) => e.transactionHash === log.transactionHash);

    results.push({
      token: args.token,
      curve: args.curve,
      deployer: args.deployer,
      pairToken: args.pairToken,
      graduationThreshold: args.graduationThreshold,
      launchBlock: log.blockNumber!,
      launchTxHash: log.transactionHash!,
      devBuyTokens,
      devBuyTaxBps,
      exemptWalletCount: exemptInThisTx.length,
      deployerLaunchCountInWindow: deployerCounts.get(args.deployer) ?? 1,
    });
  }

  return results.sort((a, b) => Number(b.launchBlock - a.launchBlock));
}

export function devBuyPercentOfCurveSupply(devBuyTokens: number | null): number | null {
  if (devBuyTokens === null) return null;
  return (devBuyTokens / SOLD_ON_CURVE_SUPPLY) * 100;
}
