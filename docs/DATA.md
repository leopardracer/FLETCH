# Where the data comes from

Researched fresh for this project (chain APIs move fast; don't trust this file blindly a year from now — verify against the linked sources).

## Chain

- **RPC**: `rpc.mainnet.chain.robinhood.com`, chain ID `4663` (testnet `46630`). Robinhood Chain is an Arbitrum Orbit L2 settling to Ethereum, ~0.1s blocks, gas paid in ETH. The public endpoint is free but rate-limited and explicitly not meant for production — see https://docs.robinhood.com/chain/. For anything beyond light development use, get a dedicated endpoint (Quicknode, Alchemy, etc.).
- **Pons V2** — the bonding-curve launchpad FLETCH tracks. Factory, router, meme-hook, locker, and graduation-executor addresses, plus every event ABI in `src/chain/pons.ts`, were verified in [GTTM](https://github.com/leopardracer/GTTM) against Bitquery's Pons docs (https://docs.bitquery.io/docs/blockchain/robinhood/pons-api/) two ways: a keccak-256 preimage match against the verified contract source, and live occurrence on chain. If Pons ships a v3 or changes these, `src/chain/pons.ts` is the one place to update.
- **Blockscout** — Robinhood Chain's official explorer (`robinhoodchain.blockscout.com`), with a PRO API at `api.blockscout.com?chain_id=4663`. Free key from https://dev.blockscout.com. Used as an optional accelerator for holder counts instead of a full `Transfer` log replay — see `src/data/providers/blockscoutProvider.ts`. **Not exercised against a live key in this environment** (the sandbox this was built in only allows outbound requests to package registries) — smoke-test before relying on it.
- **CoinGecko** — free, no-key `simple/price` endpoint, used for ETH→USD conversion of the pair asset. Best-effort; a failed request shows `unavailable`, never a stale or guessed number.

## What's real right now

New-token discovery, launch-moment risk signals (dev-buy %, bundled/exempt wallets, serial-deployer detection), holder count + top accumulators + whale moves (full `Transfer` log replay from the launch block), pre-graduation liquidity and price (the curve's own balance and last trade), buy/sell counts and volume since launch.

## What's explicitly unavailable, and why

### Post-graduation (Uniswap v4) pricing

Once a Pons token graduates, it trades in a Uniswap v4 pool. v4 has no per-pool contract with `getReserves()` like v2 — pools live inside a shared `PoolManager` singleton keyed by `PoolId`. Reading a live price out of that needs either a `StateView`/quoter contract call, or an indexer that already decodes v4 trades. **Bitquery already indexes Robinhood Chain's v4 trades and pool liquidity** (https://docs.bitquery.io/docs/blockchain/robinhood/) — wiring a Bitquery-backed `ChainDataProvider` is the fix. Not implemented here; `src/chain/liquidity.ts` returns `graduated: true` with price/liquidity left `null` rather than guessing.

### Smart Money

<a id="smart-money"></a>

Real win-rate / early-entry / historical-performance tracking needs either:
1. a persistence layer that accumulates per-wallet outcomes across every token FLETCH has ever scored, run for weeks-to-months, or
2. an indexer with that history already built — Bitquery's decoded trade tables are the strongest candidate.

Neither exists yet. `src/wallets/smartMoney.ts` returns an explicit `unavailable` with this exact reasoning rather than a plausible-looking fake wallet leaderboard.

### Social

<a id="social"></a>

No reliable social-mentions/sentiment API specific to Robinhood Chain tokens was found during research. `src/social/social.ts` returns `unavailable`. Wiring the X/Twitter API or a social-listening vendor is a real scope-and-cost decision, not a code gap — flag it back to product before building against one.

### Holder growth *rate*

The current "Holder Growth" score component uses absolute holder count, not a trend, because there's no snapshot history store to diff against. Needs a database (see [DEVELOPMENT.md](./DEVELOPMENT.md#next-steps)).

## Provider landscape, if you're deciding what to add next

| Provider | Gives you | Cost |
|---|---|---|
| Public RPC | Raw reads, works today | Free, rate-limited |
| Blockscout | Holder/tx endpoints, official explorer | Free tier with API key |
| Bitquery | Decoded v4/v3/Pons trades, pool liquidity, Pons launch feed, GraphQL + WebSocket streams | 7-day trial, paid from ~$49/mo |
| CoinGecko | USD conversion | Free |

`ChainDataProvider` (see [ARCHITECTURE.md](./ARCHITECTURE.md)) is the seam: a Bitquery-backed provider slots in at `src/api/server.ts`'s one `new RpcChainDataProvider()` call without touching scoring, risk, or the API routes.
