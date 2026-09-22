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

**Phase 2 built the foundation for (1); Phase 4 adds the missing piece — price-at-trade.**

- **What's recorded.** Every real `CurveBuy` / `CurveSell` off a token's own Pons V2 bonding curve goes into `wallet_trades` (`src/persistence/walletTradesStore.ts`) with its exact token and ETH amounts and the price implied by *that* trade — not the token's latest price. The logs come from the scan `chain/liquidity.ts` already runs to read the last trade price, so this adds **zero extra RPC calls**. `UNIQUE(tx_hash, log_index)` makes overlapping re-scans idempotent. Trades are attributed to the event's `recipient` (who actually received the tokens or the ETH), so a trade routed through the Pons router lands on the person, not the router. Native-ETH-paired launches only, so every amount is in one known unit.
- **Coverage, not just trades.** Every scan also records the block range it covered (`trade_scan_coverage`). PnL is only computed over a token's **gap-free history starting at its launch block**. An older token whose first scan was capped by `MAX_HOLDER_SCAN_BLOCKS`, or a gap between two scans, means a buy or sell may have been missed — and a cost basis built on a missed trade would be wrong, so those trades simply don't count.
- **What's computed** (`src/wallets/positions.ts`, average-cost method): per-token positions (`OPEN` / `CLOSED` / `UNKNOWN_COST_BASIS`), **real realized PnL in ETH**, and **real win rate** (share of fully closed positions that realized a profit). If a wallet sells more than FLETCH saw it buy on the curve — tokens received by transfer, say — that position is `UNKNOWN_COST_BASIS` and excluded, never filled in with a guessed entry price.
- **Unrealized PnL** — tokens still held × the token's latest curve trade price − their average cost, summed across open positions. REAL only if *every* open position can be valued honestly: token not graduated, a curve price from the last 24h, and gap-free coverage all the way to the latest scan (otherwise a sell after a gap could mean the tokens are gone). If any one fails, the whole metric is `UNAVAILABLE` with a count — never a partial total that reads smaller than it is.
- **Early-entry timing** — median number of blocks between each token's launch block and this wallet's first buy, over positions FLETCH saw from launch. In blocks, not seconds.
- **Still honestly not there:** average holding period (only block numbers are stored per trade, not timestamps) — explicit `NOT_YET_IMPLEMENTED` on `GET /api/wallets/:address`. Post-graduation (Uniswap v4) trades aren't read, so a position exited after graduation shows as `OPEN` rather than as a guessed exit. The FLETCH Score's Smart Money component (`src/wallets/smartMoney.ts`) stays `unavailable` until enough real closed positions have accumulated across wallets to rank them — one wallet's win rate on two trades isn't a "smart money" label.

### Social

<a id="social"></a>

No reliable social-mentions/sentiment API specific to Robinhood Chain tokens was found during research. `src/social/social.ts` returns `unavailable`. Wiring the X/Twitter API or a social-listening vendor is a real scope-and-cost decision, not a code gap — flag it back to product before building against one.

### Holder growth *rate*

<a id="holder-growth-rate"></a>

**Resolved in Phase 2.** With persistence in place, Holder Growth is a real percentage once a previous snapshot exists — see [SCORING.md](./SCORING.md). It still falls back to an absolute-count proxy for a token's first-ever read (no prior snapshot to compare against), labeled honestly rather than presented as a rate.

### Holder count for an old token

<a id="holder-scan-bounds"></a>

**Confirmed against real Robinhood Chain mainnet, not theoretical — and it turned out to be six call sites, not one.** Every `eth_getLogs` call in `chain/*.ts` and `data/providers/rpcProvider.ts` that scans a wide, unbounded block range has the same shape: holder counts (`chain/holders.ts`), a token's launch-record lookup (`chain/launch.ts`'s `readLaunchRecord`, which defaulted to scanning from block 0 — the single widest possible range), graduation status (`readCurveState`), last-trade price (`chain/liquidity.ts`'s `lastTradePrice`), the buy/sell/volume count in `getTokenMetrics`, and `getTransfers`. A live test hit this directly: first a ~237,000-block holder scan rejected outright by the public RPC, then — after fixing only that one site — a wider live run against a real paid-tier provider (QuickNode) still failed every single per-token check, because the *other* five sites were still making the same unbounded call. Real free-tier providers (checked directly against both QuickNode's and Alchemy's own docs) cap a single `eth_getLogs` call at 5–10 blocks; paid tiers raise that to 2,000–10,000.

All six now go through the same two shared, tested primitives in `chain/logScan.ts`:
- **`fetchLogsInChunks`** — splits any range into sequential chunks of at most `LOG_SCAN_CHUNK_BLOCKS` (default 2,000) blocks each, never one call spanning the full range. Fails fast on the first chunk that errors, rather than returning partial results — a count or lookup built from an incomplete log set would be genuinely *wrong*, not just less precise, so there's no honest partial-success path here the way there is for launch enrichment (see [RISK.md](./RISK.md)).
- **`boundedScanStart`** — caps how far back a scan will ever look (`MAX_HOLDER_SCAN_BLOCKS`, default 20,000), even for an old token whose true starting point (launch block, or — for `readLaunchRecord`'s default — genesis) is much further back. This isn't just about avoiding one giant request: chunking alone would turn an old token's full history into potentially *hundreds* of sequential requests, trading one rejected call for a near-certain rate-limit trip. Capping the lookback bounds the number of chunks directly.

Past the cap, every affected field says so honestly rather than silently presenting a partial result as complete: `holderCountIsLifetime` becomes `false`, and `TokenMetrics.graduated` / `LiquidityInfo.graduated` become `null` — not `false` — when a bounded graduation check finds no event, since "no event in the window checked" is not the same claim as "never graduated." (Finding an event, by contrast, is conclusive regardless of bounding — once graduated, always graduated.)

## Provider landscape, if you're deciding what to add next

| Provider | Gives you | Cost |
|---|---|---|
| Public RPC | Raw reads, works today | Free, rate-limited |
| Blockscout | Holder/tx endpoints, official explorer | Free tier with API key |
| Bitquery | Decoded v4/v3/Pons trades, pool liquidity, Pons launch feed, GraphQL + WebSocket streams | 7-day trial, paid from ~$49/mo |
| CoinGecko | USD conversion | Free |

`ChainDataProvider` (see [ARCHITECTURE.md](./ARCHITECTURE.md)) is the seam: a Bitquery-backed provider slots in at `src/api/server.ts`'s one `new RpcChainDataProvider()` call without touching scoring, risk, or the API routes.
