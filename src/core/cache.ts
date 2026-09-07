/**
 * A tiny in-memory cache for data that's either genuinely immutable
 * (token symbol/name/decimals never change once a contract is deployed)
 * or safe to treat as immutable within a process lifetime (a mined
 * block's own timestamp never changes). No TTL needed for either — the
 * cache is cleared only by process restart. This directly answers the
 * brief's "cache immutable contract data / cache recent blocks" item
 * without pulling in a caching library for what a Map already does.
 */
export class ImmutableCache<K, V> {
  private store = new Map<K, V>();

  async getOrCompute(key: K, compute: () => Promise<V>): Promise<V> {
    const cached = this.store.get(key);
    if (cached !== undefined) return cached;
    const value = await compute();
    this.store.set(key, value);
    return value;
  }

  get size(): number {
    return this.store.size;
  }
}
