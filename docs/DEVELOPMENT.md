# Development

## Prerequisites

- Node.js ≥ 22.6.0 — `node:sqlite` (used for all persistence, see [Persistence](#persistence)) doesn't exist at all before Node 22.5, and 22.5.0/22.5.1 themselves were missing it on some platform builds; see the `engines` field in `package.json`.
- A Robinhood Chain RPC URL (the public `rpc.mainnet.chain.robinhood.com` works for development — see [DATA.md](./DATA.md))

## Setup

```bash
git clone https://github.com/leopardracer/FLETCH.git
cd FLETCH
npm install
cp .env.example .env
# edit .env — at minimum, set RPC_URL
```

## Commands

These are the actual scripts in `package.json` — nothing here is invented.

| Command | What it does |
|---|---|
| `npm run dev` | Type-checks, builds, and starts the API + dashboard on `PORT` (default `8787`) |
| `npm run build` | Type-checks and compiles `src/` to `dist/` |
| `npm start` | Runs the already-built `dist/index.js` (run `build` first) |
| `npm test` | Builds, then runs the full test suite (`node --test`) — see [Tests](#tests) below for the full breakdown |
| `npm run screenshot` | Generates real dashboard screenshots via Playwright — see `scripts/screenshot.mjs` (separate install, not a project dependency) |

Open `http://localhost:<PORT>` after `npm run dev`.

## API

| Endpoint | Returns |
|---|---|
| `GET /api/health` | chain connectivity, Blockscout/poller config state |
| `GET /api/tokens?window=<blocks>` | Tokens feed — new launches ranked by FLETCH Score |
| `GET /api/signals?limit=<n>` | Chain-wide live signal feed, severity then recency |
| `GET /api/tokens/:address` | full token intelligence: metrics, risk, score, signals, why-it's-moving, data availability |
| `GET /api/tokens/:address/history` | persisted snapshot history for that token |
| `GET /api/tokens/:address/signals` | signal timeline for that token |
| `GET /api/tokens/:address/wallets` | wallet activity for that token (per-token scope) |
| `GET /api/wallets/:address` | wallet intelligence — real participation record + explicit NOT_YET_IMPLEMENTED metrics |

## Environment variables

See `.env.example` for the full, current list with inline explanations. The important ones:

- `RPC_URL` — **required**. No default is baked in on purpose.
- `BLOCKSCOUT_API_KEY` — optional. Unset means FLETCH runs entirely on raw RPC log scanning.
- `DB_PATH` — SQLite file path, default `./fletch.db`. Delete it to reset all history.
- `ENABLE_POLLER` / `POLL_INTERVAL_MS` / `POLL_TOKEN_LIMIT` — the background snapshot poller (see [Persistence](#persistence)). Only starts if `RPC_URL` is set.
- `SNAPSHOT_MIN_INTERVAL_SECONDS` — minimum gap between two recorded snapshots for the same token.

## Persistence

<a id="persistence"></a>

Node's built-in `node:sqlite` — the "simplest production-appropriate" option the brief asked for: no separate database server, no new runtime dependency (still 5 in `package.json`). It's labeled experimental by Node itself as of the Node version this was built against; that's real, not hidden. Three tables (`token_snapshots`, `signals`, `wallet_activity`) — see [ARCHITECTURE.md](./ARCHITECTURE.md). Swapping to Postgres or `better-sqlite3` later touches only `src/persistence/`, nothing above it.

Tests use `useInMemoryDbForTests()` (`:memory:`, fresh schema) rather than the configured file — no test touches disk or a live database.

## Performance

<a id="performance"></a>

What Phase 2 actually changed, not just discussed:

- **Fixed a real bug**: `RpcChainDataProvider.getNewTokens` was fetching a block it never used (`latestBlock`) — removed.
- **Immutable-data cache** (`src/core/cache.ts`, a `Map` — no library): token symbol/name/decimals (never change post-deploy) and block timestamps (never change once mined) are cached for the process lifetime. Repeated feed refreshes for the same tokens no longer re-fetch this.
- **Snapshot rate-limiting**: `SNAPSHOT_MIN_INTERVAL_SECONDS` stops rapid page views (or a poll tick landing right after a page view) from writing near-duplicate rows.

Still not done: batching the feed endpoint's per-launch RPC calls (dev-buy + exempt-wallet lookups — one round-trip per detected launch) via multicall. Fine for a normal window, slow on a very busy one against a rate-limited public RPC.

## Tests

<a id="tests"></a>

Every test is deterministic — no live RPC calls, no real database file (persistence tests use `node:sqlite`'s `:memory:` mode via `useInMemoryDbForTests()`), no wall-clock timing (every function that reads "now" takes it as an injectable parameter, defaulting to `Date.now()` only at the real call site). Same input, same output, every run, every machine.

| Command | What it runs |
|---|---|
| `npm test` | The full suite — 96 tests across 12 files |
| `npm run test:integration` | Just the two files that exercise multiple layers together (see below) |
| `npm run test:coverage` | Full suite with Node's built-in coverage report (`--experimental-test-coverage`, zero new dependencies) |
| `npm run test:watch` | Builds once, then re-runs on every change to the compiled output — pair with `tsc -p tsconfig.json --watch` in another terminal for full auto-rebuild |

**Unit tests** (pure logic, one file per module):

| File | Tests | Covers |
|---|---|---|
| `signals/signalEngine.test.ts` | 12 | every signal type: buy/sell pressure, whale-move classification, risk-promoted signals, all four trend signals (holder growth/decline, liquidity change, price movement, activity acceleration), and that nothing fires without the data to back it |
| `scoring/fletchScore.test.ts` | 11 | every component formula, weight re-normalization when components are unavailable, the whale-activity availability rule (unavailable only when the scan itself failed, not when it found zero whales), the real-vs-proxy holder-growth branch |
| `risk/riskAnalysis.test.ts` | 10 | every finding threshold, including the trend-based ones (liquidity deterioration, abnormal sell pressure) that only fire with real snapshot history |
| `persistence/snapshots.test.ts` | 9 | the comparison-window lookup, rate limiting, history ordering, per-token isolation, null-score round-tripping |
| `ai/explain.test.ts` | 7 | every bullet traces to a real signal's own text; risk-derived signal types don't get double-shown |
| `persistence/signalsStore.test.ts` | 7 | severity-then-recency ordering, per-token isolation, case-insensitive addressing |
| `persistence/walletActivityStore.test.ts` | 6 | profile aggregation, token-breadth dedup, per-wallet isolation |
| `wallets/walletScore.test.ts` | 5 | every metric is explicitly `NOT_YET_IMPLEMENTED` with a stated reason — never a computed number, even with a long recorded history |
| `core/config.test.ts` | 8 | env parsing, including a regression test for a real boolean-coercion bug this pass found and fixed (see below) |
| `poller/poller.test.ts` | 1 | the `ENABLE_POLLER=false` off-switch actually schedules nothing |

**Integration tests** (`npm run test:integration`):

| File | Tests | Covers |
|---|---|---|
| `signals/signalService.test.ts` | 10 | the real pipeline — chain metrics → risk → score → signals → persistence — through `analyzeAndPersist`, the one function every real code path (API, poller) calls. Includes signal deduplication: a rapid repeat read must not re-file identical signal rows, but a genuinely later read must |
| `api/server.test.ts` | 10 | end-to-end smoke tests — boots the real Express app, hits it over real HTTP, checks every endpoint responds correctly (including graceful, clear errors when RPC isn't configured, never a crash or hang) |

**Two real bugs this test pass found and fixed** (not hypothetical — both reproduced before the fix):
- `ENABLE_POLLER=false` in `.env` was silently ignored. `z.coerce.boolean()` uses JS's `Boolean(value)` coercion, and `Boolean("false")` is `true` — any non-empty string coerces truthy. Fixed with a proper string-aware parser; regression test in `core/config.test.ts`.
- Signal history wasn't deduplicated. Snapshots were correctly rate-limited, but every detected signal was still persisted on every call regardless — three rapid page views wrote three identical `BUY_PRESSURE` rows. Fixed by only persisting signals alongside a genuinely new snapshot.

## Coverage

<a id="coverage"></a>

```sh
npm run test:coverage
```

74.30% line coverage / 74.35% branch / 64.44% function, on real application code — test files are excluded from the number via `--test-coverage-exclude="**/*.test.js"`. Not chasing 100%: the coverage that matters is on the code that computes something, not the code that calls an external service.

| Area | Line coverage | Why |
|---|---|---|
| `signals/`, `scoring/`, `risk/`, `ai/`, `persistence/`, `wallets/walletScore.ts` | 91–100% | pure logic or fully mockable via in-memory SQLite — no excuse not to cover it |
| `api/server.ts` | 67% | the success paths that need a live RPC connection are the uncovered lines; every error path is covered |
| `chain/*.ts`, `data/providers/rpcProvider.ts` | 23–96% (mostly low) | these call `viem` against a real RPC endpoint — meaningfully testing them needs either a live testnet or mocking the chain client, and mocking blockchain responses risks presenting fabricated data as verified, which this project's own rules rule out. Not covered by unit tests; exercised manually against a real `RPC_URL` instead |
| `poller/poller.ts` | 50% | only the off-switch is unit-tested (see above); its actual work is `analyzeAndPersist`, which is fully covered by the integration suite |
| `social.ts`, `wallets/smartMoney.ts` | low % but tiny | these are one-function honest-unavailable stubs — low coverage on a five-line file isn't a meaningful signal |

## Continuous Integration

<a id="ci"></a>

`.github/workflows/ci.yml` runs on every push to `main` and every pull request, on Node 22.x and 24.x (`node:sqlite` requires Node ≥22.5 — see the `engines` field in `package.json`; a Node 20.x leg would fail immediately with `ERR_UNKNOWN_BUILTIN_MODULE`, not because of an FLETCH bug). Each run does `npm ci`, `npm run build`, `npm test`, `npm run test:integration`, `npm run test:coverage` — any TypeScript error, failing test, or broken build fails the run.

## Next steps

<a id="next-steps"></a>

Roughly in priority order:

1. Smoke-test `src/data/providers/blockscoutProvider.ts` against a real API key; wire it into the feed endpoint to cut per-launch RPC round-trips.
2. Give the signal engine the token's launch timestamp so `ACTIVITY_ACCELERATION` can compare against a true lifetime-average baseline, not just the last snapshot's rate (see [SIGNALS.md](./SIGNALS.md)).
3. Evaluate Bitquery for post-graduation Uniswap v4 pricing and decoded trade history — a `ChainDataProvider` swap, not a rewrite.
4. Record price-at-trade in `wallet_activity` (currently only net token-amount change) — the specific missing piece blocking real PnL/win-rate in `walletScore.ts`.
5. Decide on and wire a social data source, or keep it explicitly unavailable long-term.
6. Wallet-clustering detection off existing transfer data.
7. Batch the feed endpoint's per-launch RPC calls via multicall.
