# Contributing

FLETCH's one hard rule: **never fabricate data.** Every number shown either comes from a real chain read (or a real provider like Blockscout/CoinGecko) or is displayed as `unavailable` with a stated reason. If you're adding a feature and the honest data isn't available yet, ship the `unavailable` state — don't fill the gap with a plausible-looking guess. See [docs/DATA.md](./docs/DATA.md) for what's real today and what isn't.

## Before you open a PR

```bash
npm install
npm test    # builds and runs the unit suite — must pass
```

## Where things live

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the layer breakdown. In short: chain reads go in `src/chain/`, anything consuming them goes through the `ChainDataProvider` interface in `src/data/types.ts` rather than importing `src/chain/*` directly, and risk/scoring/AI-explanation logic stays pure and unit-tested (no network calls) so it's cheap to test — see the `*.test.ts` files next to each module for the pattern.

## Adding a new data source or provider

Implement `ChainDataProvider` (`src/data/types.ts`) rather than reaching into `RpcChainDataProvider`'s internals or adding a parallel code path. If a metric your provider can't supply, return `null` for it with a reason where the type allows one (`TokenMetrics.liquidityUsdUnavailableReason` and similar) — don't estimate.

## Style

Small, explicit, and typed over clever. Prefer a `null` + reason over `try/catch` swallowing an error into a fabricated default. Comments in this codebase tend to explain *why* a limitation exists (see `src/chain/liquidity.ts`'s note on Uniswap v4) rather than just what the code does — keep that pattern when you add a similar honest gap.

## Reporting issues

Open a GitHub issue. If it's about a specific score or risk finding looking wrong, include the token address and, if you can, which component/finding — that maps directly to a function in `src/scoring/` or `src/risk/`.
