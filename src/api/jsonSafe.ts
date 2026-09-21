/**
 * Converts every `bigint` in a value to its decimal string, leaving
 * everything else — numbers, booleans, strings, nested objects/arrays,
 * null — completely untouched. This is the one JS type JSON.stringify
 * cannot serialize on its own (it throws), which is exactly what crashed
 * the process on a real GET /api/health call once RPC actually succeeded
 * (chain/client.ts's pingChain() returns a real bigint block number from
 * viem — a path this repo's test suite, running with RPC_URL unset, had
 * never exercised).
 *
 * Deliberately scoped: this is applied explicitly at the two response-
 * construction points that are known, by direct audit, to carry a
 * bigint (see docs/DEVELOPMENT.md) — not wrapped around every res.json()
 * call in the file, and not a global JSON.stringify patch. It does not
 * touch chain/data/persistence types: `pingChain()` still returns a real
 * bigint, `TokenMetrics.whaleMoves[].blockNumber` still is one — this
 * only converts the copy that becomes an HTTP response body.
 *
 * String, not Number: a block number is safely within
 * Number.MAX_SAFE_INTEGER today, but a string can never silently lose
 * precision if that ever changes, and it matches the convention
 * GET /api/tokens already uses for launchBlock.
 */
/**
 * Extracts a display string from a caught value the same way every route
 * handler in api/server.ts used to inline as `e?.message ?? "unknown
 * error"` — duck-typed on a string `.message` property (so a real Error
 * still works) rather than an `instanceof Error` check, which is what the
 * original inline expression did via optional chaining. Centralized here,
 * alongside bigIntSafe, as the other small pure helper the API's error
 * responses depend on — see server.ts's asyncRoute.
 */
export function errorMessage(e: unknown): string {
  return typeof e === "object" && e !== null && "message" in e && typeof (e as { message: unknown }).message === "string"
    ? (e as { message: string }).message
    : "unknown error";
}

export function bigIntSafe<T>(value: T): T {
  if (typeof value === "bigint") return value.toString() as unknown as T;
  if (Array.isArray(value)) return value.map((v) => bigIntSafe(v)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = bigIntSafe(v);
    return out as T;
  }
  return value;
}
