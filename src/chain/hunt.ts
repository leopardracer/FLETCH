import { formatUnits } from "viem";
import { getClient } from "./client.js";
import { config } from "../core/config.js";
import { PONS_V2_FACTORY, factoryAbi, curveAbi, SOLD_ON_CURVE_SUPPLY } from "./pons.js";
import { fetchLogsInChunks } from "./logScan.js";

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
  /** null = the per-launch enrichment read (dev-buy / exempt-wallet check)
   *  failed for this launch — e.g. RPC rate-limiting — not "zero exempt
   *  wallets, confirmed". See enrichOneLaunch. */
  exemptWalletCount: number | null;
  deployerLaunchCountInWindow: number;
}

interface RawLaunchLog {
  args: {
    token: `0x${string}`;
    curve: `0x${string}`;
    deployer: `0x${string}`;
    pairToken: `0x${string}`;
    launchConfigId: bigint;
    graduationThreshold: bigint;
  };
  blockNumber: bigint | null;
  transactionHash: `0x${string}` | null;
}

interface LaunchEnrichment {
  buyLogsInTx: { transactionHash: `0x${string}` | null; args: any }[];
  exemptLogsInTx: { transactionHash: `0x${string}` | null }[];
}

/** Fetches a single launch's dev-buy and bundled-wallet data — two extra
 *  RPC calls per launch, which is exactly what trips a rate-limited
 *  public RPC once there are several launches to enrich in one cycle
 *  (confirmed against real Robinhood Chain mainnet data). Exposed as its
 *  own function purely so enrichOneLaunch's resilience to it failing is
 *  independently testable with a fake — see hunt.test.ts. */
async function fetchLaunchEnrichment(curve: `0x${string}`, blockNumber: bigint): Promise<LaunchEnrichment> {
  const client = getClient();
  const [buyLogsInTx, exemptLogsInTx] = await Promise.all([
    client.getLogs({ address: curve, event: curveAbi[0], fromBlock: blockNumber, toBlock: blockNumber }), // CurveBuy
    client.getLogs({
      address: curve,
      event: { type: "event", name: "SnipeTaxExempted", inputs: [{ name: "account", type: "address", indexed: true }] },
      fromBlock: blockNumber,
      toBlock: blockNumber,
    }),
  ]);
  return { buyLogsInTx, exemptLogsInTx };
}

/**
 * Builds one DetectedLaunch from a real TokenLaunched log. The launch
 * itself (token/curve/deployer/pairToken/graduationThreshold/block/tx) is
 * already a known, real fact from the successful factory scan by the time
 * this runs — only the *enrichment* (dev-buy %, bundled wallets) needs a
 * further chain read, and that read can fail independently of the launch
 * being real.
 *
 * On enrichment failure, this still returns a real DetectedLaunch — never
 * drops the token — with devBuyTokens/devBuyTaxBps/exemptWalletCount all
 * left `null` (unavailable, never fabricated as 0). This is what stops
 * one rate-limited launch from losing every *other* real launch found in
 * the same discovery cycle, which is what happened before this fix:
 * scanRecentLaunches awaited each launch's enrichment in a plain loop
 * with no try/catch, so a single failure rejected the whole function and
 * every already-found launch in that batch was lost, not just the one
 * that failed.
 */
export async function enrichOneLaunch(
  log: RawLaunchLog,
  deployerLaunchCountInWindow: number,
  fetchEnrichment: (curve: `0x${string}`, blockNumber: bigint) => Promise<LaunchEnrichment> = fetchLaunchEnrichment
): Promise<DetectedLaunch> {
  const args = log.args;
  let devBuyTokens: number | null = null;
  let devBuyTaxBps: number | null = null;
  let exemptWalletCount: number | null = null;

  try {
    const { buyLogsInTx, exemptLogsInTx } = await fetchEnrichment(args.curve, log.blockNumber!);

    const devBuy = buyLogsInTx.find((b) => b.transactionHash === log.transactionHash);
    if (devBuy) {
      const b = devBuy.args as any;
      devBuyTokens = Number(formatUnits(b.tokensOut, 18));
      if (b.quoteIn > 0n) devBuyTaxBps = Number((b.tax * 10000n) / b.quoteIn);
    }

    exemptWalletCount = exemptLogsInTx.filter((e) => e.transactionHash === log.transactionHash).length;
  } catch {
    // Enrichment genuinely unavailable for this launch (rate limit, RPC
    // blip, etc.) — devBuyTokens/devBuyTaxBps/exemptWalletCount stay null.
    // The launch itself is still real and still returned below.
  }

  return {
    token: args.token,
    curve: args.curve,
    deployer: args.deployer,
    pairToken: args.pairToken,
    graduationThreshold: args.graduationThreshold,
    launchBlock: log.blockNumber!,
    launchTxHash: log.transactionHash!,
    devBuyTokens,
    devBuyTaxBps,
    exemptWalletCount,
    deployerLaunchCountInWindow,
  };
}

/**
 * Scans the Pons V2 factory for every TokenLaunched event in a recent block
 * window — FLETCH's "new token" feed, chain-wide (not scoped to one
 * token). Every field is a real chain read or a count derived from one —
 * nothing here is guessed. Per-launch enrichment failures are isolated
 * (see enrichOneLaunch) so one rate-limited launch never loses the
 * others found in the same scan.
 */
export async function scanRecentLaunches(windowBlocks?: bigint): Promise<DetectedLaunch[]> {
  const client = getClient();
  const latest = await client.getBlockNumber();
  const window = windowBlocks ?? config.signalWindowBlocks;
  const fromBlock = latest > window ? latest - window : 0n;

  // Chunked (see chain/logScan.ts) — not re-capped by MAX_HOLDER_SCAN_BLOCKS,
  // since `window` here is already the deliberate, configurable bound
  // (SIGNAL_WINDOW_BLOCKS). Confirmed against real Robinhood Chain mainnet:
  // even a single wide eth_getLogs call within a normal window gets
  // rejected outright by RPC providers with a tight per-call block-range
  // cap (free tiers on major providers cap a single call at 5-10 blocks).
  const launchLogs = await fetchLogsInChunks(
    (range) =>
      client.getLogs({
        address: PONS_V2_FACTORY,
        event: factoryAbi[0], // TokenLaunched
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
      }),
    fromBlock,
    latest,
    config.logScanChunkBlocks
  );

  const deployerCounts = new Map<string, number>();
  for (const log of launchLogs) {
    const deployer = (log.args as any).deployer as string;
    deployerCounts.set(deployer, (deployerCounts.get(deployer) ?? 0) + 1);
  }

  const results: DetectedLaunch[] = [];
  // Sequential, not Promise.all — deliberately doesn't add MORE concurrent
  // load on an already rate-limited RPC while enriching a batch of launches.
  for (const log of launchLogs) {
    const args = log.args as RawLaunchLog["args"];
    results.push(await enrichOneLaunch(log as RawLaunchLog, deployerCounts.get(args.deployer) ?? 1));
  }

  return results.sort((a, b) => Number(b.launchBlock - a.launchBlock));
}

export function devBuyPercentOfCurveSupply(devBuyTokens: number | null): number | null {
  if (devBuyTokens === null) return null;
  return (devBuyTokens / SOLD_ON_CURVE_SUPPLY) * 100;
}
