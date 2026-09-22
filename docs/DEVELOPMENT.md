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
| `GET /api/health` | chain connectivity, Blockscout/poller config state, RPC rate-limit backoff (`rpcBackoff`) |
| `GET /api/monitoring` | is FLETCH actually watching the chain right now — queue counts, recent activity, no secrets (see [docs/MONITORING.md](./MONITORING.md)) |
| `GET /api/tokens?window=<blocks>` | Tokens feed — new launches ranked by FLETCH Score |
| `GET /api/radar?window=<seconds>&limit=<n>` | Meme Radar — tokens ranked by recency-weighted signal convergence, not size (see [docs/RADAR.md](./RADAR.md)) |
| `GET /api/signals?limit=<n>` | Chain-wide live signal feed, severity then recency |
| `GET /api/tokens/:address` | full token intelligence: metrics, risk, score, signals, why-it's-moving, data availability |
| `GET /api/tokens/:address/history` | persisted snapshot history for that token |
| `GET /api/tokens/:address/signals` | signal timeline for that token |
| `GET /api/tokens/:address/wallets` | wallet activity for that token (per-token scope) |
| `GET /api/wallets/:address` | wallet intelligence — real participation record, per-token positions, real realized/unrealized PnL, win rate and early-entry timing from price-at-trade; average holding period, linked wallets |
| `GET /api/brief` | FLETCH AI market brief — last hour across Robinhood Chain, from Radar + signals (cached 2 min) |
| `GET /api/tokens/:address/ai-summary` | FLETCH AI analyst paragraph for a token whose report was just loaded (no second chain read) |
| `GET /api/ai` | whether server-side AI is configured: `{ enabled, model }` |

## Environment variables

See `.env.example` for the full, current list with inline explanations. The important ones:

- `RPC_URL` — **required**. No default is baked in on purpose.
- `BLOCKSCOUT_API_KEY` — optional. Unset means FLETCH runs entirely on raw RPC log scanning.
- `DB_PATH` — SQLite file path, default `./fletch.db`. Delete it to reset all history.
- `ENABLE_POLLER` / `POLL_INTERVAL_MS` / `POLL_TOKEN_LIMIT` — the background snapshot poller (see [Persistence](#persistence)). Only starts if `RPC_URL` is set.
- `SNAPSHOT_MIN_INTERVAL_SECONDS` — minimum gap between two recorded snapshots for the same token.
- `DISCOVERY_INTERVAL_MS` / `MAX_CONCURRENT_TOKENS` / `MAX_MONITORED_TOKENS` / `MAX_CONSECUTIVE_FAILURES` / `SIGNAL_RETENTION_DAYS` / `SNAPSHOT_RETENTION_DAYS` — continuous monitoring (see [docs/MONITORING.md](./MONITORING.md)). All have bounded, conservative defaults.
- `LOG_SCAN_CHUNK_BLOCKS` / `MAX_HOLDER_SCAN_BLOCKS` — bound a holder-count log replay (chain/holders.ts) so it stays viable against a rate-limited RPC even for an old token — see [docs/DATA.md#holder-scan-bounds](./DATA.md#holder-scan-bounds).
- `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` — per-IP request cap on `/api/*` (see api/server.ts). Defaults are generous enough for normal local/dashboard use; exists to bound RPC load if the API is ever reachable from outside localhost.

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
| `npm test` | The full suite — 238 tests across 24 files |
| `npm run test:integration` | The five files that exercise multiple layers together (see below) |
| `npm run test:coverage` | Full suite with Node's built-in coverage report (`--experimental-test-coverage`, zero new dependencies) |
| `npm run test:watch` | Builds once, then re-runs on every change to the compiled output — pair with `tsc -p tsconfig.json --watch` in another terminal for full auto-rebuild |

**Unit tests** (pure logic, one file per module):

| File | Tests | Covers |
|---|---|---|
| `signals/signalEngine.test.ts` | 16 | every signal type: buy/sell pressure, whale-move classification, risk-promoted signals, all trend signals (holder growth/decline, liquidity change, price movement, activity acceleration), `PHASE_CHANGE`, the phase-transition guard on liquidity signals, and that nothing fires without the data to back it |
| `chain/hunt.test.ts` | 5 | `enrichOneLaunch`'s resilience — a failed per-launch enrichment (e.g. RPC rate-limit) returns a real launch with null dev-buy/exempt-wallet fields, never drops the launch, never fabricates a zero |
| `chain/launch.test.ts` | 3 | `deriveGraduated` — a capped graduation-check scan that finds no event is genuinely unknown, not a confirmed `false`; finding an event is conclusive regardless of bounding |
| `api/jsonSafe.test.ts` | 9 | `bigIntSafe` — the exact `whaleMoves` and `pingChain()` shapes that crashed `JSON.stringify` in live testing, proven fixed |
| `radar/radarEngine.test.ts` | 13 | every Radar formula constant: per-severity magnitude, recency decay, the convergence multiplier, the 0–100 clamp, and that volume (the same signal repeating) never scores higher than the same signal firing once |
| `signals/types.test.ts` | 4 | `pickTopSignal` — regression test for a real bug where the API surfaced the first-detected signal instead of the most severe one |
| `scoring/fletchScore.test.ts` | 11 | every component formula, weight re-normalization when components are unavailable, the whale-activity availability rule (unavailable only when the scan itself failed, not when it found zero whales), the real-vs-proxy holder-growth branch |
| `risk/riskAnalysis.test.ts` | 13 | every finding threshold, including the trend-based ones (liquidity deterioration, abnormal sell pressure) that only fire with real snapshot history, and the phase-transition guard suppressing a false "collapse" across a graduation |
| `persistence/snapshots.test.ts` | 16 | the comparison-window lookup, rate limiting, history ordering, per-token isolation, null-score round-tripping, latest-snapshot lookup, risk-level and phase persistence, retention pruning, and recent-activity counts |
| `ai/explain.test.ts` | 7 | every bullet traces to a real signal's own text; risk-derived signal types don't get double-shown |
| `ai/rephrase.test.ts` | 5 | rephrase-only LLM call degrades to the deterministic bullets (never throws, never blank) with no client, a failed call, or an empty model response — injects a fake Anthropic client, no real API key |
| `ai/chatAgent.test.ts` | 8 | the tool-use loop against a fake Anthropic client and fake deps: disabled-without-a-key reply, each of the three tools, invalid-address rejection before any chain call, the radar result-count cap, and the `maxTurns` graceful stop instead of looping forever |
| `persistence/signalsStore.test.ts` | 14 | severity-then-recency ordering, per-token isolation, case-insensitive addressing, time-windowed queries, distinct-token discovery for Meme Radar, retention pruning, and recent-activity counts |
| `persistence/walletActivityStore.test.ts` | 6 | profile aggregation, token-breadth dedup, per-wallet isolation |
| `wallets/walletScore.test.ts` | 5 | every metric is explicitly `NOT_YET_IMPLEMENTED` with a stated reason — never a computed number, even with a long recorded history |
| `core/config.test.ts` | 12 | env parsing, including regression tests for a real boolean-coercion bug, the bounded safe defaults of every monitoring parameter, and the log-scan bounds |
| `chain/logScan.test.ts` | 12 | `fetchLogsInChunks` and `boundedScanStart` — the two shared, pure pieces behind every bounded log scan in `chain/*.ts` (holder counts, launch lookup, graduation check, last-trade price, buy/sell counts, transfers), including a direct regression test for the real ~237,000-block failure |
| `poller/poller.test.ts` | 1 | the `ENABLE_POLLER=false` off-switch actually schedules nothing |
| `monitoring/monitoringStore.test.ts` | 13 | discovery dedup, priority-ordered scheduling, the consecutive-failure cutoff, that a failure never touches real metric data, and that a stored launch (including its bigint fields) round-trips exactly |

**Integration tests** (`npm run test:integration`):

| File | Tests | Covers |
|---|---|---|
| `signals/signalService.test.ts` | 10 | the real pipeline — chain metrics → risk → score → signals → persistence — through `analyzeAndPersist`, the one function every real code path (API, monitoring) calls. Includes signal deduplication: a rapid repeat read must not re-file identical signal rows, but a genuinely later read must |
| `radar/radarService.test.ts` | 10 | persisted signals + snapshots → ranked Radar entries through `getRadar()`, the real function the API calls. Sorting, window exclusion, honest nulls when a token has signals but no snapshot yet, and that symbol resolution degrades to `null` instead of throwing without `RPC_URL` |
| `monitoring/monitoringService.test.ts` | 17 | discovery → queue → bounded monitoring cycle → `analyzeAndPersist`, using dependency-injected fake providers (never live RPC): successful checks persisting real snapshots, failed checks never writing fake metrics, the consecutive-failure cutoff, one broken token never blocking the rest of a batch, and every priority tier |
| `monitoring/monitoringService.stress.test.ts` | 3 | the scheduler at 100 and 1,000 fake monitored tokens — real (not just configured) bounded concurrency, zero duplicate work, and discovery capped at `MAX_MONITORED_TOKENS` even with 1,000 simultaneous launches. Explicitly does not claim 10,000-token support — see [docs/MONITORING.md#scale](./MONITORING.md#scale) |
| `api/server.test.ts` | 18 | end-to-end smoke tests — boots the real Express app, hits it over real HTTP, checks every endpoint responds correctly (including graceful, clear errors when RPC isn't configured, and that `/api/monitoring` never leaks a secret) |

**Bugs this project's test-writing has found and fixed** (not hypothetical — each reproduced before the fix):
- `ENABLE_POLLER=false` in `.env` was silently ignored. `z.coerce.boolean()` uses JS's `Boolean(value)` coercion, and `Boolean("false")` is `true` — any non-empty string coerces truthy. Fixed with a proper string-aware parser; regression test in `core/config.test.ts`.
- Signal history wasn't deduplicated. Snapshots were correctly rate-limited, but every detected signal was still persisted on every call regardless — three rapid page views wrote three identical `BUY_PRESSURE` rows. Fixed by only persisting signals alongside a genuinely new snapshot.
- The `topSignal` field on `GET /api/tokens` rows was `signals[0]` — the first signal detected in the engine's fixed code order, not the most severe one. Fixed with a dedicated, tested `pickTopSignal()` helper.
- (Continuous Monitoring phase) The original poller re-derived launch-moment facts (curve address, dev-buy data) from raw chain logs on every single cycle, for every token, forever — a real, needless RPC cost once a durable queue made "check the same token repeatedly" the normal case instead of a coincidence. Fixed by caching those facts once at discovery (`monitored_tokens.launch_json`).
- A single rate-limited launch-enrichment call during discovery rejected `scanRecentLaunches()`'s entire return value, losing every other real launch already found in that same scan — not hypothetical, reproduced against real Robinhood Chain mainnet. Fixed by isolating each launch's enrichment (`enrichOneLaunch`).
- A holder-count Transfer log replay for an old token could span hundreds of thousands of blocks in a single `eth_getLogs` call — confirmed against real mainnet data (~237,000 blocks), rejected outright by the public RPC. Fixed with chunked, bounded scanning (`fetchLogsInChunks`, `boundedScanStart` — see [docs/DATA.md#holder-scan-bounds](./DATA.md#holder-scan-bounds)).
- That same fix turned out to cover only 1 of 6 identical unbounded-scan call sites — `readLaunchRecord` (defaulting to a scan from block 0), `readCurveState`, `lastTradePrice`, and two more in `rpcProvider.ts` all had the same shape. Confirmed against a real paid-tier provider (QuickNode): every single monitoring check still failed after the first fix, because the other five sites were untouched. All six now share the same bounded/chunked primitives (`chain/logScan.ts`). Also caught in the same pass: a capped graduation check that finds nothing had been reporting `graduated: false` — a real fabrication risk, since the true event could be outside the checked window. Fixed to return `null` (unknown) instead — see `deriveGraduated` in `chain/launch.ts`.

## Coverage

<a id="coverage"></a>

```sh
npm run test:coverage
```

87.54% line coverage / 87.26% branch / 74.27% function, on real application code — test files are excluded from the number via `--test-coverage-exclude="**/*.test.js"`. Not chasing 100%: the coverage that matters is on the code that computes something, not the code that calls an external service.

| Area | Line coverage | Why |
|---|---|---|
| `signals/`, `scoring/`, `risk/`, `persistence/`, `monitoring/`, `wallets/walletScore.ts`, `ai/explain.ts`, `ai/rephrase.ts`, `ai/chatAgent.ts` | 90–100%¹ | pure logic or fully mockable via in-memory SQLite and dependency-injected fakes (`chatAgent.test.ts` / `rephrase.test.ts` inject a fake Anthropic client — no real API key needed) — no excuse not to cover it |
| `api/server.ts` | ~70% | the success paths that need a live RPC connection are the uncovered lines; every error path is covered |
| `chain/*.ts`, `data/providers/rpcProvider.ts`, `intel/tokenIntel.ts` | mostly low | these call `viem` against a real RPC endpoint (`tokenIntel.ts` is the assembly point that does this on every field) — meaningfully testing the calls themselves needs either a live testnet or mocking the chain client, and mocking blockchain responses risks presenting fabricated data as verified, which this project's own rules rule out. The pieces that don't touch the network directly (`hunt.ts`'s `enrichOneLaunch` resilience, `holders.ts`'s chunking/bounding) are extracted and unit-tested; the RPC calls themselves are exercised manually against a real `RPC_URL` instead |
| `ai/client.ts` | ~68% | same exception, one level up the stack: constructing the real Anthropic client only happens with a real `ANTHROPIC_API_KEY`, which the test suite deliberately never sets (see `docs/AI.md#testing`) — every other AI module takes a client as a parameter specifically so it never needs to |
| `poller/poller.ts` | ~50% | only the off-switch is unit-tested; its actual work is `monitoringService.ts`'s cycles, which are fully covered separately |
| `social.ts`, `wallets/smartMoney.ts` | low % but tiny | these are one-function honest-unavailable stubs — low coverage on a five-line file isn't a meaningful signal |

¹ `chatAgent.ts` itself is 94% — the ~6% gap is `createDefaultAgentDeps()`'s real wiring (a live `RpcChainDataProvider`), the same live-network exception as the row below, not untested logic.

## Continuous Integration

<a id="ci"></a>

`.github/workflows/ci.yml` runs on every push to `main` and every pull request, on Node 22.x and 24.x (`node:sqlite` requires Node ≥22.5 — see the `engines` field in `package.json`; a Node 20.x leg would fail immediately with `ERR_UNKNOWN_BUILTIN_MODULE`, not because of an FLETCH bug). Each run does `npm ci`, `npm run build`, `npm test`, `npm run test:integration`, `npm run test:coverage` — any TypeScript error, failing test, or broken build fails the run.

## Next steps

<a id="next-steps"></a>

Roughly in priority order:

1. Smoke-test `src/data/providers/blockscoutProvider.ts` against a real API key; wire it into the feed endpoint to cut per-launch RPC round-trips.
2. ~~Give the signal engine the token's launch timestamp so `ACTIVITY_ACCELERATION` can compare against a true lifetime-average baseline~~ — **done** (see [SIGNALS.md](./SIGNALS.md)).
3. Evaluate Bitquery for post-graduation Uniswap v4 pricing and decoded trade history — a `ChainDataProvider` swap, not a rewrite.
4. ~~Record price-at-trade per wallet~~ — **done**: `wallet_trades` + `wallets/positions.ts` (see [DATA.md](./DATA.md#smart-money)).
5. Decide on and wire a social data source, or keep it explicitly unavailable long-term.
6. ~~Wallet-clustering detection~~ — **done**: `wallets/clusters.ts` (see [DATA.md](./DATA.md#smart-money)).
7. ~~Batch per-launch RPC calls via multicall~~ — **done, opt-in** via a verified `MULTICALL3_ADDRESS` (see [MONITORING.md](./MONITORING.md)).
8. ~~Automatic reactivation of a `FAILED` monitored token~~ — **done**, together with RPC rate-limit backoff (see [MONITORING.md](./MONITORING.md)).
9. ~~A real DETECTED→STRENGTHENING→FADING signal lifecycle~~ — **done**, `signals/lifecycle.ts` (see [MONITORING.md](./MONITORING.md)).
