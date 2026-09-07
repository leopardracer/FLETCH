# Signal detection

`src/signals/signalEngine.ts` (pure, deterministic) + `src/signals/signalService.ts` (orchestration: fetches the previous snapshot, calls the engine, persists the result).

FLETCH's Tokens feed (`GET /api/tokens`) and Signals feed (`GET /api/signals`) are deliberately not market-cap leaderboards or flat lists — the goal is "something unusual is happening here."

## Discovery

Every new token is discovered from a single source of truth: the Pons V2 factory's `TokenLaunched` event. `scanRecentLaunches()` scans a configurable block window (`SIGNAL_WINDOW_BLOCKS`, default 50,000) and, for each launch, pulls from the *same log batch* (no extra RPC round-trips for this part): the deployer's launch count within the window, and the launch transaction's own `CurveBuy`/`SnipeTaxExempted` events.

## Signal types

Every `Signal` has a `type`, `severity` (LOW/MEDIUM/HIGH/CRITICAL — see below), `confidence` (0–100), `evidence` (the exact number(s) behind it), an `explanation` sentence, and a `timestamp`. `confidence` is **not** a statistical interval — it's a deterministic tier tied to how much real data backs the signal (sample size for point-in-time signals, elapsed time for trend signals). See the formulas in `signalEngine.ts` directly; nothing here is invented separately from the code.

**Point-in-time** (no history needed — computed from the current scan window alone):

| Type | Fires when | Notes |
|---|---|---|
| `BUY_PRESSURE` / `SELL_PRESSURE` | buy/sell ratio in the window is lopsided, with at least 3 trades total | avoids calling a single trade a "signal" |
| `WHALE_BUY_FROM_CURVE` / `WHALE_SELL_TO_CURVE` | a whale-threshold transfer's `from`/`to` matches the token's own curve address | direction is only asserted when the curve address is known |
| `WHALE_TRANSFER` | a whale-threshold transfer neither into nor out of the curve | wallet-to-wallet — direction/intent is explicitly *not* inferred |
| `DEPLOYER_RISK`, `BUNDLED_WALLETS`, `SERIAL_DEPLOYER`, `HOLDER_CONCENTRATION`, `THIN_LIQUIDITY` | promoted 1:1 from a `RiskFinding` with that `code` (see [RISK.md](./RISK.md)) at MEDIUM+ | same evidence text as the risk finding — never duplicated with different wording |

**Trend** (only fire with a real previous snapshot within the comparison window — never approximated from one data point):

| Type | Fires when |
|---|---|
| `HOLDER_GROWTH` / `HOLDER_DECLINE` | holder count changed since the last snapshot |
| `LIQUIDITY_INCREASE` / `LIQUIDITY_DECREASE` | liquidity moved ≥10% since the last snapshot |
| `PRICE_UP` / `PRICE_DOWN` | price moved ≥5% since the last snapshot |
| `ACTIVITY_ACCELERATION` | trade rate since the last snapshot is ≥0.5/min — reports the real observed rate, not a comparison to a historical baseline (see limitation below) |

## The comparison window

`signalService.COMPARISON_WINDOW_SECONDS` (600s / 10 minutes) is the brief's own framing — "what changed in the last 10 minutes?" Every trend signal, trend-based risk finding, and the Holder Growth score component all use the same window, so they agree on what "recent" means for a given read.

## Where the history comes from

Persistence (`src/persistence/`, Node's built-in `node:sqlite`) records a snapshot on every token-page read (rate-limited by `SNAPSHOT_MIN_INTERVAL_SECONDS` so rapid repeat views don't spam near-duplicate rows) and, if `ENABLE_POLLER=true` and `RPC_URL` is set, on a background interval (`POLL_INTERVAL_MS`) across the most recently launched tokens (`POLL_TOKEN_LIMIT`). See `src/poller/poller.ts` and [DEVELOPMENT.md](./DEVELOPMENT.md).

## Known limitation: activity acceleration isn't compared to a baseline

`ACTIVITY_ACCELERATION` reports a real trades-per-minute rate between two snapshots — it does **not** compare that rate to the token's own historical average (true acceleration, a second derivative), because that would need the token's launch timestamp threaded through the signal engine, which isn't wired up yet. The evidence text says exactly what was measured ("N trades in the last Xm") rather than implying a baseline comparison that wasn't made.

## Not implemented

**Wallet clustering** (multiple wallets behaving as one entity — shared funding source, correlated timing) isn't implemented. It's buildable off the same `Transfer` log data FLETCH already reads, but wasn't in scope for this pass.

## Design principle

Every signal's `evidence` traces back to a specific number computed in `signalEngine.ts`, `riskAnalysis.ts`, or a persisted snapshot. If a signal type isn't listed here, it isn't computed — nothing in the UI shows a signal that isn't backed by this table.
