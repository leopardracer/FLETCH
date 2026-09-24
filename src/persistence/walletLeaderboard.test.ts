import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useInMemoryDbForTests } from "./db.js";
import { saveLaunchRecord } from "./launchRegistry.js";
import { recordCurveScan, type CurveTrade } from "./walletTradesStore.js";
import { getWalletLeaderboard } from "./walletLeaderboard.js";

beforeEach(() => { useInMemoryDbForTests(); });

const ETH = "0x0000000000000000000000000000000000000000";
const T1 = "0x1111111111111111111111111111111111111111" as const;
const T2 = "0x2222222222222222222222222222222222222222" as const;
const TERC = "0x3333333333333333333333333333333333333333" as const;
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const C = "0xcccccccccccccccccccccccccccccccccccccccc" as const;

function launch(token: `0x${string}`, pairToken: string) {
  saveLaunchRecord({
    found: true, token, curve: token, deployer: token, pairToken: pairToken as `0x${string}`,
    launchConfigId: 1n, graduationThreshold: 1n, launchBlock: 1n, launchTxHash: ("0x" + "e".repeat(64)) as `0x${string}`,
  } as never);
}
let n = 0;
function tr(wallet: `0x${string}`, side: "buy" | "sell", eth: number, block: number): CurveTrade {
  n++;
  return { wallet, side, quoteAmount: eth, tokenAmount: 1000, blockNumber: block, logIndex: n, txHash: ("0x" + n.toString(16).padStart(64, "0")) as `0x${string}` };
}

test("empty database → honest empty leaderboard, no latest block", () => {
  const lb = getWalletLeaderboard({ windowBlocks: 1000 });
  assert.equal(lb.latestBlock, null);
  assert.deepEqual(lb.wallets, []);
});

test("aggregates per wallet across tokens: trades, buys/sells, tokens, ETH in/out, net flow", () => {
  launch(T1, ETH); launch(T2, ETH);
  recordCurveScan(T1, 1, 1, 1000, [tr(A, "buy", 1.5, 900), tr(A, "sell", 2.0, 950), tr(B, "buy", 0.2, 960)]);
  recordCurveScan(T2, 1, 1, 1000, [tr(A, "buy", 0.5, 990)]);
  const lb = getWalletLeaderboard({ windowBlocks: 1000 });
  assert.equal(lb.latestBlock, 990);
  assert.equal(lb.totalWallets, 2);
  assert.equal(lb.totalTrades, 4);
  const a = lb.wallets[0];
  assert.equal(a.wallet, A);
  assert.deepEqual([a.trades, a.buys, a.sells, a.tokens], [3, 2, 1, 2]);
  assert.equal(a.ethBought, 2.0);
  assert.equal(a.ethSold, 2.0);
  assert.equal(a.netFlow, 0);
});

test("the window counts back from the newest recorded trade — older trades are left out", () => {
  launch(T1, ETH);
  recordCurveScan(T1, 1, 1, 10_000, [tr(A, "buy", 5, 100), tr(B, "buy", 1, 9_900)]);
  const lb = getWalletLeaderboard({ windowBlocks: 500 });
  assert.equal(lb.fromBlock, 9_401);
  assert.deepEqual(lb.wallets.map((w) => w.wallet), [B]);
});

test("ERC-20-paired launches are excluded, so every amount is ETH", () => {
  launch(T1, ETH); launch(TERC, "0x4444444444444444444444444444444444444444");
  recordCurveScan(T1, 1, 1, 100, [tr(A, "buy", 1, 50)]);
  recordCurveScan(TERC, 1, 1, 100, [tr(C, "buy", 50_000, 60)]);
  const lb = getWalletLeaderboard({ windowBlocks: 1000 });
  assert.deepEqual(lb.wallets.map((w) => w.wallet), [A]);
});

test("sorts: buyers by ETH spent, sellers by ETH received", () => {
  launch(T1, ETH);
  recordCurveScan(T1, 1, 1, 100, [tr(A, "buy", 3, 10), tr(B, "buy", 1, 11), tr(B, "buy", 1, 12), tr(C, "sell", 4, 13)]);
  assert.equal(getWalletLeaderboard({ windowBlocks: 100, sort: "active" }).wallets[0].wallet, B);
  assert.equal(getWalletLeaderboard({ windowBlocks: 100, sort: "buyers" }).wallets[0].wallet, A);
  assert.equal(getWalletLeaderboard({ windowBlocks: 100, sort: "sellers" }).wallets[0].wallet, C);
});
