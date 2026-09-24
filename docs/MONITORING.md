# Continuous Monitoring

`src/monitoring/monitoringStore.ts` (the durable queue) + `src/monitoring/monitoringService.ts` (discovery/monitoring/retention cycles) + `GET /api/monitoring`.

## The shift this represents

Before this: FLETCH analyzed a token when someone opened its page, or when the old poller re-scanned a fixed recent-launch window on a timer. There was no persistent notion of "which tokens FLETCH is watching," no priority, no failure tracking, and a token older than the most recent ~15 launches simply stopped being checked, no matter how active it was.

Now: a durable, prioritized, restart-safe monitoring queue (`monitored_tokens`, a SQLite table like everything else FLETCH persists) drives two independent cycles:

```
Robinhood Chain
      ↓
Launch Discovery   (bounded scan, every DISCOVERY_INTERVAL_MS)
      ↓
Monitoring Queue    (monitored_tokens — survives restart)
      ↓
Snapshot Collector  (every POLL_INTERVAL_MS, bounded concurrency)
      ↓
Previous Snapshot ──┐
      ↓             │ (existing comparison logic — see SIGNALS.md)
Change Detection ←──┘
      ↓
Signal Engine       (unchanged — signalEngine.ts remains the only source of signal semantics)
      ↓
Persistence
      ↓
Radar               (unchanged — reads the same signals/snapshots tables)
      ↓
Dashboard / API
```

## Discovery

`runDiscoveryCycle()` scans the same bounded recent-launch window the Tokens feed already scans (`SIGNAL_WINDOW_BLOCKS`) — never the whole chain. For each launch, `upsertDiscovered()` adds it to the queue **only if it isn't already there** (the token address is the table's primary key, so re-discovering a known launch is a cheap no-op, not a duplicate row or a reset of its monitoring state). A new discovery also caches its launch-moment facts (curve address, dev-buy data — see below) and starts at NORMAL priority with its first full check deferred by `QUIET_AFTER_SECONDS` (15 min) — see [Activity sweep](#activity-sweep): most launches never trade, and a full check on every one of them used to eat the whole check budget.

Bounded by `MAX_MONITORED_TOKENS`: once the queue is at capacity, further discoveries are skipped and counted (`skippedCapacity`), not silently dropped or allowed to grow storage/RPC load without limit.

## Why launch data is cached, not re-derived

The signal and risk engines need launch-moment facts (curve address for whale classification, dev-buy percentage, bundled-wallet count) that only exist in the `TokenLaunched` transaction's own logs. The *original* poller re-scanned and re-derived these from raw chain logs on **every single cycle**, for the same tokens, forever — a real, needless RPC cost. Since these facts never change once a token launches, `monitored_tokens.launch_json` captures them once at discovery and every later check reuses the cached copy. (JSON, not a live object — the two `bigint` fields serialize to strings and back; see `serializeLaunch`/`deserializeLaunch` in `monitoringStore.ts`.)

## Snapshot collection

`runMonitoringCycle()` pulls whatever's due (`next_check_at <= now`, ordered by priority) and processes it with **bounded concurrency** (`MAX_CONCURRENT_TOKENS` in flight at once, regardless of how many are queued) via a small manual worker pool — no new dependency. Every check goes through `signals/signalService.ts`'s existing `analyzeAndPersist()` — **the same function the API and token pages already call** — so there is exactly one place signal semantics live, not a second parallel signal system inside the monitor.

**On failure, nothing about the token's real metrics is ever written.** Only the monitoring queue's own metadata changes: `failure_count` increments, `last_error` records the real error message, and the next attempt is scheduled at the normal retry interval. A token failing `MAX_CONSECUTIVE_FAILURES` times in a row (default 5) is marked `FAILED` and **stops being scheduled entirely** — this is what stops a single permanently-broken address (a self-destructed contract, a malformed response) from retrying forever and wasting RPC calls on every cycle. Every monitoring cycle also runs `reactivateFailed()`: a `FAILED` token that has sat out `FAILED_REACTIVATE_AFTER_SECONDS` (default 6h) since its last check goes back to `ACTIVE` with a fresh failure budget — so a stretch of real failures doesn't leave tokens dead until a restart, while a genuinely broken address still costs at most `MAX_CONSECUTIVE_FAILURES` checks per cool-off window.

**Rate limits are not token failures.** Found in live use: when the RPC provider ran out of quota (HTTP 429, then QuickNode's "daily request limit reached"), every cycle kept firing a full batch at a dead provider, and every one of those errors counted against a perfectly healthy token. `core/rpcBackoff.ts` now tells the two apart. A rate-limit error opens a circuit breaker: the rest of the batch isn't started, the token is rescheduled for when the pause ends with **no** failure count or `last_error` change, and both cycles skip chain reads until then. The pause starts at `RPC_BACKOFF_BASE_MS` and doubles per consecutive rate limit up to `RPC_BACKOFF_MAX_MS`; a daily-quota error goes straight to the maximum. Any successful read resets it. The poller logs one line per pause (not one per request), and `GET /api/health` reports it as `rpcBackoff`.

One broken token in a batch never stops the rest — each check's failure is caught independently inside the worker pool.

## Change detection & signal lifecycle

Unchanged from the existing signal engine (`SIGNALS.md`): a signal only fires when a real threshold is crossed comparing the current metrics against the previous *persisted* snapshot. A flat, unchanged token produces zero signals, by construction — polling frequency was never what generates a signal, the underlying delta is.

**Deduplication** already existed at the snapshot level (`SNAPSHOT_MIN_INTERVAL_SECONDS` — see `signals/signalService.ts`): a read that doesn't produce a new snapshot doesn't re-persist identical signal rows either. This monitoring layer doesn't change that; it's simply what generates the periodic reads that make the existing mechanism matter continuously instead of only on page views.

**Signal lifecycle — DETECTED → STRENGTHENING / STEADY → FADING → RESOLVED** (`src/signals/lifecycle.ts`). Derived at read time from the signal rows FLETCH already persists — no new table, no state machine to keep in sync, no chain reads. For each signal type on a token, the most recent window is compared against the one before it: DETECTED (fired now, not before), STRENGTHENING (more often than before, or at a higher severity), STEADY (about the same), FADING (less often, or silent now but seen within 3 windows), RESOLVED (silent for 3+ windows). The window is Radar's default (30 min). Surfaced on every Radar entry (`topSignalLifecycle`), on `GET /api/tokens/:address/signals` (`lifecycle`), on the dashboard's Radar cards and token signal timeline, and in the AI market brief. Descriptive only: STRENGTHENING means "happening more than it was", never a prediction that it continues. The storage-side dedup described above is unchanged.

## Recency

Every timestamp here is real: `taken_at`/`timestamp` columns are `Math.floor(Date.now() / 1000)` at the moment of the check (or an injected clock in tests — see below), never fabricated or backdated. Block timestamps (used for token age, `Token.launchTimestamp`) come from the chain itself via `chain/hunt.ts`. Monitoring-operation timestamps (`first_detected_at`, `last_checked_at`, etc.) are system time, since they describe FLETCH's own observation schedule, not an on-chain event.

## Token lifecycle / phase

<a id="phase"></a>

`TokenMetrics.graduated` (real data, already computed by `chain/liquidity.ts`'s curve-state read, but previously dropped before reaching signals/persistence) now flows through to `token_snapshots.graduated` and `monitored_tokens.phase` (`CURVE` | `GRADUATED` | unknown). Robinhood Chain / Pons V2 only has two phases FLETCH can currently observe — there's no separate onchain "LAUNCH" state distinct from the curve trading phase.

**The important guarantee the brief calls out**: comparing incompatible metrics across a phase transition must never look like a "collapse." A new `PHASE_CHANGE` signal reports a graduation as its own honest, observed event, and both `signals/signalEngine.ts`'s `LIQUIDITY_INCREASE`/`LIQUIDITY_DECREASE` and `risk/riskAnalysis.ts`'s `LIQUIDITY_DETERIORATION` explicitly skip their comparison whenever the phase differs between the two snapshots being compared. In practice, the existing null-safety already prevented the specific false-signal case today (post-graduation liquidity reads as `null`, and the comparison requires both sides non-null) — the explicit guard makes the rule correct-by-construction rather than correct-by-coincidence, and keeps it correct if a future provider (e.g. Bitquery, see `DATA.md`) starts returning a real post-graduation liquidity number.

## Activity sweep

<a id="activity-sweep"></a>

Found live on app.getfletch.xyz: ~3,300 tokens launched on Robinhood Chain in a day, most never traded, and every one got a full check (holders, liquidity, trade history — several RPC calls) the moment it was discovered, at HIGH priority for its first hour. The check budget went to dead launches; 474 of 500 queued tokens had never been checked; the tokens people were actually trading were barely read.

`monitoring/activitySweep.ts` answers "which watched tokens are being traded right now?" for the **whole queue** with a handful of calls: one `eth_getLogs` for the `CurveBuy`/`CurveSell` events of up to 100 curves at a time, over just the blocks since the previous sweep (every `ACTIVITY_SWEEP_INTERVAL_MS`, default 60 s). Then:

- a token with a new curve trade → **HIGH, due now** (`markActive`), and `last_activity_block` is recorded;
- a launch watched for 15 minutes with no trade ever (and none recorded) → **LOW** before it ever costs a full check (`demoteQuietLaunches`) — it stays queued, is first in line for eviction when the queue is full, and is promoted straight back to HIGH if it ever trades;
- a trade in the launch block itself is the deployer's dev buy, not market activity, and is ignored;
- a rate-limited sweep changes nothing — a failed read is not evidence of "no trades" — and the same blocks are swept again after the pause.

## Priority

<a id="priority"></a>

`computeNextPriority()` (in `monitoringService.ts`) runs after each full check:

| Condition | Priority |
|---|---|
| Has traded, and discovered less than 1 hour ago | **HIGH** |
| Never traded, still inside its 15-minute quiet window | **NORMAL** |
| Never traded, past its quiet window (a never-traded token's signals are static risk facts, not activity) | **LOW** |
| Has a signal within the last 30 minutes (Radar's own window) | **HIGH** |
| Has ever produced a signal, but not recently | **NORMAL** |
| Otherwise | **LOW** |

Check interval scales with priority off the same `POLL_INTERVAL_MS` base: HIGH = 1×, NORMAL = 3×, LOW = 8×. A quiet token still gets checked — just less often, so it can't silently starve the concurrency budget that active tokens need.

## Radar integration

Nothing changed in `radar/radarEngine.ts` or `radar/radarService.ts` — the audit found no bug to fix there, per the brief's own instruction not to change the scoring model without one. The integration is exactly as simple as intended: `analyzeAndPersist()` writes a new signal row → Radar's `getDistinctTokensWithRecentSignals()` picks it up on the very next `GET /api/radar` call. Radar remains convergence-based, recency-weighted, risk-separated, explainable, and deterministic — see `RADAR.md`.

## API

`GET /api/monitoring` — no auth, no secrets. Never returns `RPC_URL`, API keys, or any other configuration secret; only counts, intervals, and timestamps.

```json
{
  "enabled": true,
  "discoveryIntervalMs": 300000,
  "pollIntervalMs": 300000,
  "maxConcurrentTokens": 5,
  "maxMonitoredTokens": 500,
  "totalMonitored": 42,
  "activeCount": 40,
  "pausedCount": 0,
  "failedCount": 2,
  "completedCount": 0,
  "dueNowCount": 6,
  "lastSuccessfulCheckAt": 1730000000,
  "nextScheduledCheckAt": 1730000300,
  "snapshotsLastHour": 118,
  "signalsLastHour": 23
}
```

## Configuration

All in `.env.example`, all with bounded, conservative defaults so a misconfiguration can't accidentally hammer the RPC provider:

| Variable | Default | What it bounds |
|---|---|---|
| `DISCOVERY_INTERVAL_MS` | 300000 (5 min) | how often the launch scan + retention prune run |
| `ACTIVITY_SWEEP_INTERVAL_MS` | 60000 (1 min) | how often every watched curve is checked for new trades in one batched read |
| `MAX_CONCURRENT_TOKENS` | 5 | in-flight chain reads per monitoring cycle |
| `MAX_MONITORED_TOKENS` | 500 | hard cap on the queue itself |
| `MAX_CONSECUTIVE_FAILURES` | 5 | checks before a token is marked FAILED and stops being scheduled |
| `FAILED_REACTIVATE_AFTER_SECONDS` | 21600 (6h) | cool-off before a FAILED token gets a fresh retry budget; 0 disables |
| `RPC_BACKOFF_BASE_MS` / `RPC_BACKOFF_MAX_MS` | 60000 / 3600000 | first pause after an RPC rate limit (doubling) and its ceiling |
| `MULTICALL3_ADDRESS` | unset | optional, operator-verified Multicall3 — aggregates concurrent contract reads into one `eth_call` |
| `SIGNAL_RETENTION_DAYS` / `SNAPSHOT_RETENTION_DAYS` | 30 / 30 | how long history is kept before `runRetentionCycle()` prunes it |

`POLL_INTERVAL_MS` / `POLL_TOKEN_LIMIT` / `ENABLE_POLLER` (pre-existing) still govern the check cadence and the master on/off switch.

## Performance & scale

<a id="scale"></a>

Concretely verified by `monitoring/monitoringService.stress.test.ts` (deterministic, in-memory, a fake provider with an artificial delay so overlapping work is actually observable — not a live benchmark):

- **100 monitored tokens**: concurrency reaches exactly the configured limit; every token checked exactly once, no duplicates.
- **1,000 monitored tokens**: the same bound holds at 10× scale, and wall time reflects real parallelism (well under the fully-serial equivalent), not a linear blowup.
- **Discovery with 1,000 simultaneous launches**: stops at `MAX_MONITORED_TOKENS` (default 500) rather than growing the queue unbounded.

**FLETCH does not claim to support 10,000 monitored tokens** — that would need a real benchmark against real RPC latency and rate limits, which this repository doesn't have (see `DATA.md` on the public RPC's own rate limiting). The architecture (bounded concurrency, priority scheduling, a hard queue cap) is designed to degrade gracefully well past 1,000, but "designed to" and "verified to" are different claims, and only the latter is asserted here.

Other performance-relevant existing behavior, unchanged: `core/cache.ts`'s immutable-data cache for token symbol/name/decimals and block timestamps (see `DEVELOPMENT.md#performance`) applies to monitoring checks the same as it does to page-view checks — a token's metadata is still only ever fetched once per process lifetime.

## Security

FLETCH is read-only. Nothing in this monitoring layer signs a transaction, holds a private key, or submits anything to the chain — every chain interaction is a read (`getBytecode`, `getLogs`, `readContract`, `getBalance`). `GET /api/monitoring` exposes operational counts only; no secret, credential, or RPC URL is ever included in a response. There is no user-controlled address anywhere in the discovery or monitoring path — candidates come exclusively from the Pons V2 factory's own `TokenLaunched` events, never from client input, so there's no way for a caller to make FLETCH spend RPC calls checking an arbitrary address it didn't itself discover.

## Real data vs. unavailable

**Real:** everything above — discovery, the monitoring queue, bounded concurrency, priority scheduling, failure tracking with a hard stop, phase tracking, the phase-transition guard, retention pruning, and the `/api/monitoring` counts.

**Not built in this pass:**
- Verified support beyond ~1,000 tokens (see "Performance & scale" above).
