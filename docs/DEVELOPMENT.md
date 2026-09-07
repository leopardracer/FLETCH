# Development

## Prerequisites

- Node.js ≥ 20
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

Open `http://localhost:<PORT>` after `npm run dev` — the dashboard is served by the same Express process as the API (`src/api/server.ts`, `express.static`).

## Environment variables

See `.env.example` for the full, current list with inline explanations. The important ones:

- `RPC_URL` — **required**. No default is baked in on purpose (see `src/core/config.ts`) — a missing value fails loudly with a link to `docs.robinhood.com/chain`, rather than silently pointing at a shared endpoint that might be down or rate-limited without your knowledge.
- `BLOCKSCOUT_API_KEY` — optional. Unset means FLETCH runs entirely on raw RPC log scanning (slower per call, functionally complete). See [DATA.md](./DATA.md).
- `SIGNAL_WINDOW_BLOCKS` — how far back the Early Signals feed scans when no window is given.
- `PORT` — API/dashboard port, default `8787`.

## Tests

`npm test` runs real unit tests against the pure logic — scoring, risk analysis, and the explanation generator. These need no network access and are the right place to add coverage as the scoring/risk formulas evolve:

- `src/risk/riskAnalysis.test.ts` — every risk threshold, with the exact evidence string checked
- `src/scoring/fletchScore.test.ts` — component availability, weight re-normalization, momentum/liquidity formulas
- `src/ai/explain.test.ts` — every bullet traces back to a number that was actually passed in

There are no tests against live chain calls yet — those would need either a testnet fixture or a recorded-response harness, neither of which exists in this MVP.

## Database

None. FLETCH currently recomputes everything from the chain on every request — there's no persistence layer. This is the main structural gap blocking real Smart Money tracking and a real holder-growth *rate* (see [DATA.md](./DATA.md) and [SCORING.md](./SCORING.md)). A Postgres instance with a `token_snapshots` table (holder count, liquidity, score, taken periodically) is the natural first addition.

## Next steps

<a id="next-steps"></a>

Roughly in priority order:

1. Smoke-test `src/data/providers/blockscoutProvider.ts` against a real API key; wire it into the feed endpoint to cut per-token RPC round-trips on `GET /api/tokens`.
2. Add a persistence layer (Postgres is fine) for periodic snapshots — unlocks real holder-growth rate and volume/holder *acceleration* signals (see [SIGNALS.md](./SIGNALS.md)), and is the prerequisite for Smart Money tracking.
3. Evaluate Bitquery for post-graduation Uniswap v4 pricing and decoded trade history. `ChainDataProvider` is designed for this to be a provider swap at one call site (`src/api/server.ts`), not a rewrite.
4. Decide on and wire a social data source, or keep it explicitly unavailable long-term rather than build against an unreliable one.
5. Wallet-clustering detection off existing `Transfer` log data (see [SIGNALS.md](./SIGNALS.md)).
6. Batch the feed endpoint's per-launch RPC calls (dev-buy + exempt-wallet lookups) via multicall — currently one round-trip per detected launch, fine for a normal window, slow on a very busy one against a rate-limited public RPC.
