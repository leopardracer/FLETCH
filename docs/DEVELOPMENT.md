# Development

## Prerequisites

- Node.js ≥ 20 (Node 22+ recommended — `node:sqlite` is used for persistence, see [Persistence](#persistence))
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
| `npm test` | Builds, then runs the unit test suite (`node --test`) |
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

`npm test` runs real unit tests against pure logic — scoring, risk analysis, the signal engine, and the explanation generator. All deterministic, no network calls, no live database:

- `src/risk/riskAnalysis.test.ts`
- `src/scoring/fletchScore.test.ts`
- `src/signals/signalEngine.test.ts` *(new)*
- `src/ai/explain.test.ts`

38 tests total (up from 19 before Phase 2 — coverage grew, nothing was removed). There are still no tests against live chain calls — those would need a testnet fixture or a recorded-response harness, neither of which exists yet.

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
