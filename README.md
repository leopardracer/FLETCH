# FLETCH

The meme intelligence layer for Robinhood Chain. Answers: *what's happening right now, why, and should you pay attention* — for tokens launched on Pons V2.

Not a trading bot. No execution path exists in this repo.

## Status: MVP, real data only, several components explicitly unavailable

Every number FLETCH shows is either a real chain read or a clearly labeled `unavailable` with a stated reason. Nothing is fabricated to make the UI look complete. See [What's real vs. not built yet](#whats-real-vs-not-built-yet) below before you rely on this for anything.

## Quick start

```bash
npm install
cp .env.example .env
# fill in RPC_URL — see .env.example for where to get one
npm run dev
# open http://localhost:8787
```

`RPC_URL` is required for anything to work. The chain's public endpoint
(`https://rpc.mainnet.chain.robinhood.com`, chain ID 4663) is rate-limited
and fine for development; for anything beyond light use, get a dedicated
endpoint (Quicknode, Alchemy, etc.) — see https://docs.robinhood.com/chain/.

`BLOCKSCOUT_API_KEY` is optional (free key at https://dev.blockscout.com).
Without it, FLETCH works entirely off raw RPC log scanning — slower per
call, but functionally complete for the MVP. **The Blockscout acceleration
path (`src/data/providers/blockscoutProvider.ts`) has not been exercised
against a live key in this environment's sandbox (outbound network here
is allowlisted to package registries only) — smoke-test it against your
own key before depending on it.**

## What's real vs. not built yet

**Real, live chain data:**
- New-token discovery — every `TokenLaunched` event on the Pons V2 factory
- Launch-moment risk signals — dev-buy %, bundled/exempt wallets, serial-deployer detection
- Holder count + top accumulators + whale moves — full `Transfer` log replay from launch block
- Pre-graduation liquidity and price — the bonding curve's own balance and last trade
- Buy/sell counts and volume in the pair asset, since launch
- USD conversion via CoinGecko (best-effort; shows `unavailable` if the feed fails)
- FLETCH Score's Momentum, Liquidity, Holder Growth, and Safety components
- Risk levels (LOW/MEDIUM/HIGH/CRITICAL) with the exact evidence for each finding

**Explicitly unavailable — not faked:**
- **Post-graduation (Uniswap v4) pricing.** v4 pools live in a shared PoolManager with no per-pool `getReserves()` — reading real price/liquidity there needs a StateView/quoter call or an indexer (Bitquery already decodes Robinhood Chain v4 trades; wiring that in is the fix, not implemented here).
- **Smart Money.** No cross-token wallet-performance history exists — that needs either a persistence layer accumulating outcomes over weeks/months, or an indexer with that history already built. `src/wallets/smartMoney.ts` returns `unavailable` rather than a fake leaderboard.
- **Social.** No reliable social-mentions/sentiment source for Robinhood Chain tokens was identified. `src/social/social.ts` returns `unavailable`. Wiring the X/Twitter API or a listening vendor is a real cost decision, not a code gap.
- **Holder growth rate.** Scores absolute holder count today, not a trend — there's no snapshot history store yet to diff against.

The FLETCH Score only weights the components that are actually available for a given token, and shows why the rest aren't — see `src/scoring/fletchScore.ts`.

## Architecture

```
src/
  core/      config, price feed
  chain/     Robinhood Chain + Pons V2 reads (viem) — ported and generalized
             from github.com/leopardracer/GTTM's sniper engine, which
             verified these contract addresses/event signatures against
             Bitquery's Pons docs and live chain occurrence
  data/      ChainDataProvider interface — the abstraction boundary.
             Everything above this layer depends only on data/types.ts,
             never on viem or a specific provider directly. A Bitquery-
             backed provider (unlocks v4 pricing, decoded trades, wallet
             history) can implement the same interface later without
             touching scoring/risk/api.
  risk/      LOW/MEDIUM/HIGH/CRITICAL findings with evidence
  wallets/   smart-money tracking (currently: honest UNAVAILABLE stub)
  social/    social signal (currently: honest UNAVAILABLE stub)
  scoring/   the FLETCH Score — weights only available components
  ai/        "why is it moving" — templated from structured signals,
             never a free-form model call touching raw numbers
  api/       Express server + static dashboard host
web/         dashboard (dark burnt-orange terminal aesthetic per brief —
             no logo/brand files existed in the repo to preserve, so this
             is a first pass, not a restoration of an existing identity)
```

## API

- `GET /api/health` — chain connectivity check
- `GET /api/tokens?window=<blocks>` — Early Signals feed, ranked by FLETCH Score
- `GET /api/tokens/:address` — full token intelligence page (metrics, score, risk, why-it's-moving)

## Known limitations

- `getNewTokens`/the feed endpoint does a few RPC round-trips per detected launch (dev-buy + exempt-wallet lookups) — fine for a normal window, slow on a very busy one with a rate-limited public RPC. A batched multicall is the obvious next step.
- Holder counts are computed by replaying every `Transfer` log from launch — exact, but doesn't scale to "continuously score hundreds of live tokens." Either Blockscout's counters endpoint (see above, unverified here) or a real indexer is the path past this.
- No database. Nothing persists between requests — every call recomputes from the chain. Wallet-history and holder-growth-rate both need one.
- No tests yet beyond the type-check. Scoring/risk logic is pure and unit-testable — that's the natural first test target.

## What to build next

1. Smoke-test the Blockscout provider against a real key; wire it into the feed endpoint to cut per-token RPC round-trips
2. Add persistence (Postgres is fine) for score/holder history — unlocks real holder-growth-rate and is the prerequisite for smart-money tracking
3. Evaluate Bitquery for v4 post-graduation pricing and decoded trade history — the ChainDataProvider interface is designed for this to be a provider swap, not a rewrite
4. Decide on and wire a social data source, or leave it explicitly unavailable long-term
5. Real brand/logo assets for the dashboard — none exist in the repo yet
