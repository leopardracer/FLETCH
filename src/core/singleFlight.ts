/**
 * Collapses concurrent calls for the same key into ONE underlying call.
 *
 * Why it exists: on a launch spike, fifty people opening the same token page
 * in the same second would each start the full set of chain reads for it —
 * fifty times the RPC load for one answer, on a free public RPC that answers
 * bursts with 403/429 and then pauses FLETCH's monitoring for everyone. With
 * this, the first caller starts the read and the other forty-nine await the
 * same promise. Nothing is cached after it settles (errors included), so a
 * failure is never replayed to later callers.
 */
export class SingleFlight<T> {
  private inFlight = new Map<string, Promise<T>>();

  run(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const p = (async () => {
      try {
        return await fn();
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, p);
    return p;
  }

  get size(): number {
    return this.inFlight.size;
  }
}

/**
 * One cached value with a short TTL, refreshed through a single in-flight
 * call. Used for the header's chain ping: every open dashboard polls
 * /api/health every 20s, and each poll used to cost its own eth_blockNumber.
 */
export class TtlValue<T> {
  private value: { at: number; v: T } | null = null;
  private flight = new SingleFlight<T>();

  constructor(private ttlMs: number, private now: () => number = Date.now) {}

  get(fn: () => Promise<T>): Promise<T> {
    const t = this.now();
    if (this.value && t - this.value.at < this.ttlMs) return Promise.resolve(this.value.v);
    return this.flight.run("v", async () => {
      const v = await fn();
      this.value = { at: this.now(), v };
      return v;
    });
  }
}
