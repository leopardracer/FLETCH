# Where the data comes from

Researched fresh for this project (chain APIs move fast; don't trust this file blindly a year from now — verify against the linked sources).

## Chain

- **RPC**: `rpc.mainnet.chain.robinhood.com`, chain ID `4663` (testnet `46630`). Robinhood Chain is an Arbitrum Orbit L2 settling to Ethereum, ~0.1s blocks, gas paid in ETH. The public endpoint is free but rate-limited and explicitly not meant for production — see https://docs.robinhood.com/chain/. For anything beyond light development use, get a dedicated endpoint (Quicknode, Alchemy, etc.).
- **Pons V2** — the bonding-curve launchpad FLETCH tracks. Factory, router, meme-hook, locker, and graduation-executor addresses, plus every event ABI in `src/chain/pons.ts`, were verified against Bitquery's Pons docs (https://docs.bitquery.io/docs/blockchain/robinhood/pons-api/) two ways: a keccak-256 preimage match against the verified contract source, and live occurrence on chain. If Pons ships a v3 or changes these, `src/chain/pons.ts` is the one place to update.
- **Blockscout** — Robinhood Chain's official explorer (`robinhoodchain.blockscout.com`), with a PRO API at `api.blockscout.com?chain_id=4663`. Free key from https://dev.blockscout.com. Used as an optional accelerator for holder counts instead of a full `Transfer` log replay — see `src/data/providers/blockscoutProvider.ts`. **Not exercised against a live key in this environment** (the sandbox this was built in only allows outbound requests to package registries) — smoke-test before relying on it.
- **CoinGecko** — free, no-key `simple/price` endpoint, used for ETH→USD conversion of the pair asset. Best-effort; a failed request shows `unavailable`, never a stale or guessed number.

## What's real right now

New-token discovery, launch-moment risk signals (dev-buy %, bundled/exempt wallets, serial-deployer detection), holder count + top accumulators + whale moves (full `Transfer` log replay from the launch block), pre-graduation liquidity and price (the curve's own balance and last trade), buy/sell counts and volume since launch, **persisted snapshots and signal history (Phase 2)**, **trend-based risk findings and signals once a previous snapshot exists (Phase 2)**, **the Whale Activity score component, classified against the token's own curve address (Phase 2)**, **Meme Radar's recency-weighted signal-convergence ranking, computed entirely from persisted signals and snapshots (Meme Radar) — see [docs/RADAR.md](./RADAR.md)**, **continuous discovery and prioritized monitoring with bounded concurrency and phase-aware change detection (Continuous Monitoring) — see [docs/MONITORING.md](./MONITORING.md)**.

## What's explicitly unavailable, and why

### Post-graduation (Uniswap v4) pricing

Once a Pons token graduates, it trades in a Uniswap v4 pool. v4 has no per-pool contract with `getReserves()` like v2 — pools live inside a shared `PoolManager` singleton keyed by `PoolId`. Reading a live price out of that needs either a `StateView`/quoter contract call, or an indexer that already decodes v4 trades. **Bitquery already indexes Robinhood Chain's v4 trades and pool liquidity** (https://docs.bitquery.io/docs/blockchain/robinhood/) — wiring a Bitquery-backed `ChainDataProvider` is the fix. Not implemented here; `src/chain/liquidity.ts` returns `graduated: true` with price/liquidity left `null` rather than guessing.

### Smart Money

<a id="smart-money"></a>

Real win-rate / early-entry / historical-performance tracking needs either:
1. a persistence layer that accumulates per-wallet outcomes across every token FLETCH has ever scored, run for weeks-to-months, or
2. an indexer with that history already built — Bitquery's decoded trade tables are the strongest candidate.

**Phase 2 built the foundation for (1) without finishing it**: `wallet_activity` (persisted net-change-per-token-per-timestamp, see `src/persistence/walletActivityStore.ts`) and `GET /api/wallets/:address` (`src/wallets/walletScore.ts`) expose what's actually been observed — tokens touched, first/last seen. Win rate, realized/unrealized PnL, early-entry timing, and average holding period are each explicit `NOT_YET_IMPLEMENTED` with the specific missing piece named (price-at-trade isn't recorded yet, only net token-amount change) — deliberately not filled in with a breadth-based proxy score, since that would be easy to misread as a skill signal it isn't. The `src/wallets/smartMoney.ts` stub used by the FLETCH Score's Smart Money component remains `unavailable` for the same reason.

### Social

<a id="social"></a>

No reliable social-mentions/sentiment API specific to Robinhood Chain tokens was found during research. `src/social/social.ts` returns `unavailable`. Wiring the X/Twitter API or a social-listening vendor is a real scope-and-cost decision, not a code gap — flag it back to product before building against one.

### Holder growth *rate*

<a id="holder-growth-rate"></a>

**Resolved in Phase 2.** With persistence in place, Holder Growth is a real percentage once a previous snapshot exists — see [SCORING.md](./SCORING.md). It still falls back to an absolute-count proxy for a token's first-ever read (no prior snapshot to compare against), labeled honestly rather than presented as a rate.

### Holder count for an old token

<a id="holder-scan-bounds"></a>

**Confirmed against real Robinhood Chain mainnet, not theoretical.** A holder count comes from replaying every `Transfer` log from a token's launch block (`chain/holders.ts`) — for a token launched a while ago, that single range can span hundreds of thousands of blocks. A live test hit exactly this: a ~237,000-block `eth_getLogs` call was rejected outright by the public RPC.

Two bounds, both real and both configurable (`.env.example`):
- **`LOG_SCAN_CHUNK_BLOCKS`** (default 2,000) — the log replay is split into sequential chunks of at most this many blocks each, never one call spanning the full range.
- **`MAX_HOLDER_SCAN_BLOCKS`** (default 20,000) — how far back a scan will ever look, even for an old token. This isn't just about avoiding one giant request — chunking alone would turn an old token's full history into potentially *hundreds* of sequential requests, trading one rejected call for a near-certain rate-limit trip. Capping the lookback bounds the number of chunks directly.

Past the cap, `holderCountIsLifetime` is `false` — the count is an honest, bounded recent-window figure, never silently presented as a true lifetime count it isn't. If any individual chunk's request fails (rate limit, RPC blip), the whole read fails rather than returning a holder count computed from incomplete data — a partial count would be genuinely *wrong*, not just less precise, so there's no honest partial-success path here the way there is for launch enrichment (see [RISK.md](./RISK.md)).

## Provider landscape, if you're deciding what to add next

| Provider | Gives you | Cost |
|---|---|---|
| Public RPC | Raw reads, works today | Free, rate-limited |
| Blockscout | Holder/tx endpoints, official explorer | Free tier with API key |
| Bitquery | Decoded v4/v3/Pons trades, pool liquidity, Pons launch feed, GraphQL + WebSocket streams | 7-day trial, paid from ~$49/mo |
| CoinGecko | USD conversion | Free |

`ChainDataProvider` (see [ARCHITECTURE.md](./ARCHITECTURE.md)) is the seam: a Bitquery-backed provider slots in at `src/api/server.ts`'s one `new RpcChainDataProvider()` call without touching scoring, risk, or the API routes.
