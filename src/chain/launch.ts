import { getClient } from "./client.js";
import { PONS_V2_FACTORY, factoryAbi } from "./pons.js";

export interface LaunchRecord {
  found: true;
  token: `0x${string}`;
  curve: `0x${string}`;
  deployer: `0x${string}`;
  pairToken: `0x${string}`;
  launchConfigId: bigint;
  graduationThreshold: bigint;
  launchBlock: bigint;
  launchTxHash: `0x${string}`;
}

export interface NoLaunchRecord {
  found: false;
  reason: string;
}

/**
 * Looks up a token's TokenLaunched event on the Pons V2 factory — the real
 * source for "who deployed it, and which curve backs it," with no
 * indexer needed (the factory names both as indexed args).
 */
export async function readLaunchRecord(
  tokenAddress: `0x${string}`,
  sinceBlock: bigint = 0n
): Promise<LaunchRecord | NoLaunchRecord> {
  const client = getClient();
  const latest = await client.getBlockNumber();

  const logs = await client.getLogs({
    address: PONS_V2_FACTORY,
    event: factoryAbi[0], // TokenLaunched
    args: { token: tokenAddress },
    fromBlock: sinceBlock,
    toBlock: latest,
  });

  if (logs.length === 0) {
    return {
      found: false,
      reason:
        "no TokenLaunched event found for this address on the Pons V2 factory " +
        "(could be a non-Pons token, a Pons V1 launch, or launched before sinceBlock)",
    };
  }

  const log = logs[0];
  const args = log.args as {
    curve: `0x${string}`;
    deployer: `0x${string}`;
    pairToken: `0x${string}`;
    launchConfigId: bigint;
    graduationThreshold: bigint;
  };

  return {
    found: true,
    token: tokenAddress,
    curve: args.curve,
    deployer: args.deployer,
    pairToken: args.pairToken,
    launchConfigId: args.launchConfigId,
    graduationThreshold: args.graduationThreshold,
    launchBlock: log.blockNumber!,
    launchTxHash: log.transactionHash!,
  };
}

export interface CurveState {
  graduated: boolean;
  lastPriceInPair: number | null;
  progressPercent: number | null;
}

/**
 * Reads whether a curve has graduated by checking for a CurveCompleted /
 * PoolGraduated event since launch. If not graduated, progress is left null
 * here — computing it precisely needs the curve's own view function, which
 * isn't public/documented, so liquidity.ts derives progress from the curve's
 * quote-asset balance instead of guessing at a formula.
 */
export async function readCurveState(launch: LaunchRecord): Promise<CurveState> {
  const client = getClient();
  const latest = await client.getBlockNumber();

  const graduatedLogs = await client.getLogs({
    address: PONS_V2_FACTORY,
    event: {
      type: "event",
      name: "PoolGraduated",
      inputs: [
        { name: "token", type: "address", indexed: true },
        { name: "positionId", type: "uint256", indexed: false },
        { name: "tokenAmount", type: "uint256", indexed: false },
        { name: "pairTokenAmount", type: "uint256", indexed: false },
      ],
    },
    args: { token: launch.token },
    fromBlock: launch.launchBlock,
    toBlock: latest,
  });

  return {
    graduated: graduatedLogs.length > 0,
    lastPriceInPair: null,
    progressPercent: null,
  };
}
