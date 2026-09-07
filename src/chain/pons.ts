/**
 * Pons V2 on Robinhood Chain — real, documented contract addresses and event
 * signatures. Ported verbatim from github.com/leopardracer/GTTM/src/chain/pons.ts,
 * which sourced them from Bitquery's Pons launchpad docs
 * (https://docs.bitquery.io/docs/blockchain/robinhood/pons-api/) and verified
 * each topic0 two ways: a keccak-256 preimage match against the verified
 * contract source, and live occurrence on Robinhood Chain.
 *
 * If Pons ships a v3 or changes these, this file is the one place to update.
 */

export const PONS_V2_FACTORY = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e" as const;
export const PONS_V2_ROUTER = "0xe33e9e479df8802cb0866d5d05258bec4cf62948" as const;
export const PONS_V2_MEME_HOOK = "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044" as const;
export const PONS_V2_LOCKER = "0x267444d099b10fb5ed7c3cc7b7c767adca574952" as const;
export const PONS_V2_GRADUATION_EXECUTOR = "0xc7819b64a1daecd7ec19856d026cb14efbd89046" as const;
export const UNISWAP_V4_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as const;
export const NATIVE_ETH = "0x0000000000000000000000000000000000000000" as const;

/** Addresses that hold protocol balances, not real holders — exclude from any holder count/leaderboard. */
export const PONS_PROTOCOL_ADDRESSES = [
  UNISWAP_V4_POOL_MANAGER,
  PONS_V2_LOCKER,
  PONS_V2_MEME_HOOK,
] as const;

/** Snipe tax schedule at the factory's documented current settings (owner-mutable in principle). */
export const SNIPE_TAX_START_BPS = 9900;
export const SNIPE_TAX_SECONDS = 3;

export function snipeTaxBpsAt(elapsedSeconds: number): number {
  if (elapsedSeconds >= SNIPE_TAX_SECONDS) return 0;
  return Math.floor(SNIPE_TAX_START_BPS / Math.pow(2, (elapsedSeconds * 14) / SNIPE_TAX_SECONDS));
}

export const factoryAbi = [
  {
    type: "event",
    name: "TokenLaunched",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "curve", type: "address", indexed: true },
      { name: "deployer", type: "address", indexed: true },
      { name: "pairToken", type: "address", indexed: false },
      { name: "launchConfigId", type: "uint256", indexed: false },
      { name: "graduationThreshold", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "LaunchSwept",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "quoteOut", type: "uint256", indexed: false },
      { name: "tokenOut", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PoolGraduated",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "positionId", type: "uint256", indexed: false },
      { name: "tokenAmount", type: "uint256", indexed: false },
      { name: "pairTokenAmount", type: "uint256", indexed: false },
    ],
  },
] as const;

/** Every launched token gets its OWN curve contract at a different address — this ABI is applied to whichever address TokenLaunched.curve gives you. */
export const curveAbi = [
  {
    type: "event",
    name: "CurveBuy",
    inputs: [
      { name: "buyer", type: "address", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "quoteIn", type: "uint256", indexed: false },
      { name: "tokensOut", type: "uint256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
      { name: "tax", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "CurveSell",
    inputs: [
      { name: "seller", type: "address", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "tokensIn", type: "uint256", indexed: false },
      { name: "quoteOut", type: "uint256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
      { name: "tax", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "CurveCompleted",
    inputs: [
      { name: "recipient", type: "address", indexed: false },
      { name: "quoteOut", type: "uint256", indexed: false },
      { name: "tokenOut", type: "uint256", indexed: false },
    ],
  },
] as const;

export const SOLD_ON_CURVE_SUPPLY = 714_285_714; // 5/7 of 1,000,000,000 — see Pons V2 docs
