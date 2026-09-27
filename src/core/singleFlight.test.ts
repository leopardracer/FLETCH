import { test } from "node:test";
import assert from "node:assert/strict";
import { SingleFlight, TtlValue } from "./singleFlight.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("SingleFlight: concurrent calls for one key share a single underlying call", async () => {
  const sf = new SingleFlight<number>();
  let calls = 0;
  const d = deferred<number>();
  const fn = () => {
    calls++;
    return d.promise;
  };
  const all = Promise.all([sf.run("a", fn), sf.run("a", fn), sf.run("a", fn)]);
  d.resolve(7);
  assert.deepEqual(await all, [7, 7, 7]);
  assert.equal(calls, 1);
  assert.equal(sf.size, 0, "nothing kept after settling");
});

test("SingleFlight: different keys run independently", async () => {
  const sf = new SingleFlight<string>();
  let calls = 0;
  const [a, b] = await Promise.all([
    sf.run("a", async () => (calls++, "A")),
    sf.run("b", async () => (calls++, "B")),
  ]);
  assert.equal(a, "A");
  assert.equal(b, "B");
  assert.equal(calls, 2);
});

test("SingleFlight: a failure is shared by waiters but never replayed to a later call", async () => {
  const sf = new SingleFlight<number>();
  let calls = 0;
  const d = deferred<number>();
  const p1 = sf.run("a", () => (calls++, d.promise));
  const p2 = sf.run("a", () => (calls++, d.promise));
  d.reject(new Error("rpc 403"));
  await assert.rejects(p1, /rpc 403/);
  await assert.rejects(p2, /rpc 403/);
  assert.equal(await sf.run("a", async () => (calls++, 5)), 5);
  assert.equal(calls, 2);
});

test("TtlValue: serves the cached value inside the TTL, refreshes after it", async () => {
  let t = 1000;
  const v = new TtlValue<number>(10_000, () => t);
  let calls = 0;
  const fn = async () => ++calls;
  assert.equal(await v.get(fn), 1);
  t += 9_999;
  assert.equal(await v.get(fn), 1);
  t += 2;
  assert.equal(await v.get(fn), 2);
  assert.equal(calls, 2);
});

test("TtlValue: a burst of concurrent gets on a cold cache makes one call", async () => {
  const v = new TtlValue<number>(10_000);
  let calls = 0;
  const d = deferred<number>();
  const all = Promise.all(Array.from({ length: 50 }, () => v.get(() => (calls++, d.promise))));
  d.resolve(42);
  assert.ok((await all).every((x) => x === 42));
  assert.equal(calls, 1);
});
