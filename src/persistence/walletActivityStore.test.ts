import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useInMemoryDbForTests } from "./db.js";
import { recordWalletActivity, getWalletProfile } from "./walletActivityStore.js";

const WALLET = "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;
const TOKEN_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const TOKEN_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const NOW = 1_700_000_000;

beforeEach(() => {
  useInMemoryDbForTests();
});

test("a wallet with no recorded activity returns null — not an empty object pretending to be a profile", () => {
  assert.equal(getWalletProfile(WALLET), null);
});

test("a single recorded activity produces a real profile with matching first/last-seen", () => {
  recordWalletActivity(WALLET, TOKEN_A, 1000, 1.2, NOW);
  const profile = getWalletProfile(WALLET);
  assert.ok(profile);
  assert.equal(profile!.tokensTouched.length, 1);
  assert.equal(profile!.tokensTouched[0], TOKEN_A.toLowerCase());
  assert.equal(profile!.firstSeenAt, NOW);
  assert.equal(profile!.lastSeenAt, NOW);
  assert.equal(profile!.totalRecords, 1);
});

test("tokensTouched is deduplicated — repeated activity on the same token doesn't inflate breadth", () => {
  recordWalletActivity(WALLET, TOKEN_A, 500, 1, NOW);
  recordWalletActivity(WALLET, TOKEN_A, -200, 1.1, NOW + 100);
  const profile = getWalletProfile(WALLET);
  assert.equal(profile!.tokensTouched.length, 1);
  assert.equal(profile!.totalRecords, 2); // both records counted, even though breadth is 1
});

test("activity across distinct tokens all shows up in tokensTouched", () => {
  recordWalletActivity(WALLET, TOKEN_A, 500, 1, NOW);
  recordWalletActivity(WALLET, TOKEN_B, 300, 2, NOW + 50);
  const profile = getWalletProfile(WALLET);
  assert.equal(profile!.tokensTouched.length, 2);
});

test("firstSeenAt and lastSeenAt track the real earliest/latest timestamps, not insertion order", () => {
  recordWalletActivity(WALLET, TOKEN_A, 100, 1, NOW + 500); // inserted first, but later in time
  recordWalletActivity(WALLET, TOKEN_A, 100, 1, NOW); // inserted second, but earlier in time
  const profile = getWalletProfile(WALLET);
  assert.equal(profile!.firstSeenAt, NOW);
  assert.equal(profile!.lastSeenAt, NOW + 500);
});

test("different wallets never see each other's activity", () => {
  const otherWallet = "0xdddddddddddddddddddddddddddddddddddddd" as const;
  recordWalletActivity(WALLET, TOKEN_A, 100, 1, NOW);
  recordWalletActivity(otherWallet, TOKEN_A, 999, 1, NOW);
  const profile = getWalletProfile(WALLET);
  assert.equal(profile!.totalRecords, 1);
});
