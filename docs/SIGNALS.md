# Signal detection

FLETCH's "Early Signals" feed (`GET /api/tokens`, `src/chain/hunt.ts`) is deliberately not a market-cap leaderboard — the product goal is "something unusual is happening here," not "this is currently worth the most."

## Discovery

Every new token is discovered from a single source of truth: the Pons V2 factory's `TokenLaunched` event. `scanRecentLaunches()` scans a configurable block window (`SIGNAL_WINDOW_BLOCKS`, default 50,000) and, for each launch, pulls from the *same log batch* (no extra RPC round-trips for this part):

- the deployer's launch count within the window (serial-deployer detection)
- the launch transaction's own `CurveBuy` (dev buy) and `SnipeTaxExempted` events (bundled-wallet detection)

## What currently drives ranking

The feed sorts by **FLETCH Score**, not launch recency or market cap. The score itself blends:

- **Momentum** — buy/sell activity and buy-side pressure since launch
- **Liquidity** — the curve's own real-time balance
- **Holder Growth** — current holder count (not yet a growth rate — see [DATA.md](./DATA.md#holder-growth-rate))
- **Safety** — the inverse of the risk report

See [SCORING.md](./SCORING.md) for the exact formulas.

## Signals the brief lists that aren't implemented as standalone detectors yet

The product brief names several acceleration-style signals — volume acceleration, holder acceleration, transaction acceleration, unique-buyer growth, wallet clustering — as things a mature Early Signals feed should detect. Right now FLETCH computes point-in-time values for volume, holders, and transactions, not their *rate of change*, because that needs two data points over time and there's no snapshot store yet (same gap as holder-growth rate in scoring). Once persistence exists, each of these becomes a diff between snapshots rather than a new data source — the raw numbers are already being read.

Wallet clustering (multiple wallets behaving as one entity — shared funding source, correlated timing) isn't implemented. It's a real, buildable signal off the same `Transfer` log data FLETCH already reads, but wasn't in scope for this MVP pass.

## Design principle

Every bullet the feed or a token page shows traces back to a specific chain read named in this document or [DATA.md](./DATA.md). If a signal isn't listed here, it isn't computed — the UI shows `unavailable` for it rather than a plausible number.
