import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWalletFacts } from "./walletExplain.js";
import type { WalletIntelligence } from "../wallets/walletScore.js";

const W = "0xcccccccccccccccccccccccccccccccccccccccc";

function intel(over: Partial<WalletIntelligence> = {}): WalletIntelligence {
  return {
    wallet: W,
    profile: null,
    positions: [],
    linkedWallets: [],
    metrics: {
      winRate: { availability: "UNAVAILABLE", reason: "no closed position" },
      realizedPnl: { availability: "UNAVAILABLE", reason: "no trades" },
      unrealizedPnl: { availability: "UNAVAILABLE", reason: "nothing open" },
      earlyEntryTiming: { availability: "UNAVAILABLE", reason: "no first buy" },
      averageHoldingPeriod: { availability: "NOT_YET_IMPLEMENTED", reason: "no timestamps" },
      accumulationBehavior: { availability: "UNAVAILABLE", reason: "none" },
    },
    ...over,
  };
}

test("a wallet FLETCH has never seen → one honest fact", () => {
  assert.deepEqual(buildWalletFacts(intel()), ["FLETCH has no recorded activity for wallet 0xcccc…cccc yet."]);
});

test("REAL metrics are stated with their values; unavailable ones with FLETCH's own reason — never dropped silently", () => {
  const facts = buildWalletFacts(
    intel({
      profile: { wallet: W, tokensTouched: ["a", "b"], firstSeenAt: 1, lastSeenAt: 2, totalRecords: 3 },
      positions: [
        { token: "a", status: "CLOSED", tradesCounted: 2, realizedPnlPair: 0.5, tokensHeld: 0, costBasisPair: 0, holdingBlocks: 1, firstBlock: 1, lastBlock: 2 },
        { token: "b", status: "UNKNOWN_COST_BASIS", tradesCounted: 1, realizedPnlPair: null, tokensHeld: 0, costBasisPair: null, holdingBlocks: null, firstBlock: 1, lastBlock: 1 },
      ],
      metrics: {
        ...intel().metrics,
        realizedPnl: { availability: "REAL", value: 0.5, unit: "ETH" },
        winRate: { availability: "REAL", value: 100, unit: "percent", reason: "1 of 1 fully closed position(s) realized a profit" },
      },
    })
  );
  const all = facts.join(" | ");
  assert.match(all, /touch 2 token\(s\)/);
  assert.match(all, /0 open, 1 fully closed, and 1 excluded because the wallet sold tokens FLETCH never saw it buy/);
  assert.match(all, /Realized PnL: \+0\.5 ETH/);
  assert.match(all, /Win rate: 100% \(1 of 1 fully closed/);
  assert.match(all, /Unrealized PnL: unavailable — nothing open/);
  assert.match(all, /Entry timing: unavailable — no first buy/);
});

test("negative PnL keeps its sign", () => {
  const facts = buildWalletFacts(
    intel({
      profile: { wallet: W, tokensTouched: ["a"], firstSeenAt: 1, lastSeenAt: 2, totalRecords: 1 },
      metrics: { ...intel().metrics, realizedPnl: { availability: "REAL", value: -0.25, unit: "ETH" } },
    })
  );
  assert.ok(facts.some((f) => f === "Realized PnL: -0.25 ETH."));
});

test("a coordinated-entry pattern is stated with its honest caveat", () => {
  const facts = buildWalletFacts(
    intel({
      profile: { wallet: W, tokensTouched: ["a"], firstSeenAt: 1, lastSeenAt: 2, totalRecords: 1 },
      linkedWallets: [{ wallet: "0xdddddddddddddddddddddddddddddddddddddddd", sharedTokens: 3, tokens: ["a", "b", "c"], maxBlockGap: 1 }],
    })
  );
  const f = facts.find((x) => x.startsWith("Coordinated-entry pattern"))!;
  assert.match(f, /1 other wallet\(s\)/);
  assert.match(f, /0xdddd…dddd, 3 shared token/);
  assert.match(f, /not proof of common ownership/);
});
