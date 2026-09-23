import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
process.env.RPC_URL = ""; // any chain read would throw — proves the registry path makes none
const { useInMemoryDbForTests } = await import("./db.js");
const { saveLaunchRecord, getStoredLaunchRecord } = await import("./launchRegistry.js");
const { readLaunchRecord } = await import("../chain/launch.js");

beforeEach(() => { useInMemoryDbForTests(); });
const REC = {
  found: true as const, token: "0x4f9e14FfA3C3cd2D3D7d8E80b66d2ff2dbbe81a4" as `0x${string}`, curve: "0xD5Cf30eA17CB90584F8Cf7F4B882E555A64230BC" as `0x${string}`,
  deployer: "0x000000000000000000000000000000000000dEaD" as `0x${string}`, pairToken: "0x0000000000000000000000000000000000000000" as `0x${string}`,
  launchConfigId: 3n, graduationThreshold: 10n ** 21n, launchBlock: 70453100n, launchTxHash: "0xabc" as `0x${string}`,
};

test("a stored launch record round-trips with its bigints intact, keyed case-insensitively", () => {
  saveLaunchRecord(REC);
  const r = getStoredLaunchRecord(REC.token.toLowerCase())!;
  assert.equal(r.launchBlock, 70453100n);
  assert.equal(r.graduationThreshold, 10n ** 21n);
  assert.equal(r.curve, REC.curve);
});

test("REGRESSION: readLaunchRecord answers from the registry with zero RPC — however old the token is", async () => {
  saveLaunchRecord(REC);
  const r = await readLaunchRecord(REC.token);
  assert.equal(r.found, true);
  assert.equal((r as typeof REC).launchBlock, 70453100n);
});

test("saving twice keeps the first record (a launch never changes)", () => {
  saveLaunchRecord(REC);
  saveLaunchRecord({ ...REC, curve: "0x1111111111111111111111111111111111111111" });
  assert.equal(getStoredLaunchRecord(REC.token)!.curve, REC.curve);
});
