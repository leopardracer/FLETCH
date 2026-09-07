# Meme Radar

`src/radar/radarEngine.ts` (pure scoring) + `src/radar/radarService.ts` (orchestration) + `GET /api/radar`.

## What it answers

Meme Radar answers a different question than the [FLETCH Score](./SCORING.md):

| | Question |
|---|---|
| **FLETCH Score** | How healthy/interesting is this token based on its current metrics? |
| **Radar** | How unusual and important is the change happening *right now*? |

Radar is not "tokens sorted by FLETCH Score" — that would just be the [Tokens](./SIGNALS.md) feed again. It prioritizes **change and acceleration**: buy pressure accelerating, holder growth appearing, whale activity showing up, multiple things happening at once. A token can have a mediocre FLETCH Score and still top Radar because something just started happening to it.

Radar is a ranking/intelligence surface, not a buy recommendation — strong momentum never automatically means "good." Risk is always shown alongside the Radar score, never hidden by it.

## Where the data comes from

Radar candidates are **every token with at least one persisted signal within the window** — `getDistinctTokensWithRecentSignals()` (`src/persistence/signalsStore.ts`), reading the same `signals` table the [Signals feed](./SIGNALS.md) and [signal engine](./SIGNALS.md) already write to. A token with zero recent signals is never a Radar candidate — not ranked low, not shown at all. This is also why a brand-new launch with no activity yet doesn't appear: it needs a real detected signal first.

FLETCH Score and risk level come from the token's **latest persisted snapshot** (`getLatestSnapshot()`, `src/persistence/snapshots.ts`) — not a fresh chain read. This means ranking a token on Radar needs **no live RPC call at all**; only resolving its symbol/name touches the chain client, and that degrades to `null` the same way the rest of the app does without `RPC_URL` configured.

This is also why the Radar spec's "must be persisted to improve over time" requirement is already satisfied by existing infrastructure — Radar added **one column** (`risk_level` on `token_snapshots`, previously only the numeric safety score was stored) and two read queries. No new table.

## The Radar Score

`calculateRadarScore(signalsInWindow, now, windowSeconds)` — pure, deterministic, in `radarEngine.ts`.

**1. Window.** Only signals within `RADAR_WINDOW_SECONDS_DEFAULT` (1800s / 30 minutes, overridable via `?window=` on the API) count at all. A signal from 2 hours ago contributes nothing — not decayed to near-zero, excluded outright, because Radar answers "right now."

**2. Per-type magnitude, not per-signal.** Signals are grouped by type; only the single strongest instance of each type counts. This is deliberate: a `BUY_PRESSURE` signal firing four times in the window scores exactly the same as it firing once. Radar rewards **convergence** (several different things happening at once), not **volume** (one noisy signal type recurring).

**3. Each type's contribution:**

```
magnitude = severityMagnitude[severity] × recency × (confidence / 100)
```

| Severity | Magnitude ceiling |
|---|---|
| LOW | 15 |
| MEDIUM | 35 |
| HIGH | 60 |
| CRITICAL | 85 |

`recency = max(0, 1 - age / windowSeconds)` — linear decay, 1.0 for a signal from this instant, 0 at the edge of the window. `confidence` is the signal's own 0–100 confidence tier (see [SIGNALS.md](./SIGNALS.md)).

Magnitude ceilings are deliberately short of 100 so convergence can meaningfully push a token higher than any single signal could alone.

**4. Convergence multiplier**, by count of distinct contributing signal types:

| Distinct types | Multiplier |
|---|---|
| 1 | ×1.00 |
| 2 | ×1.15 |
| 3 | ×1.30 |
| 4 or more | ×1.45 |

**5. Final score:**

```
radarScore = clamp(round(sum(magnitudes) × convergenceMultiplier), 0, 100)
```

That's the entire formula — no hidden curve-fitting, no machine-learned weights. Every number above is a constant in `radarEngine.ts`.

## Why now

`explainRadar()` returns one sentence per distinct contributing signal type, most severe first — the real `explanation` text each signal already carries (see [SIGNALS.md](./SIGNALS.md)), never rewritten or merged into an invented narrative. A token with one contributing signal type gets exactly one sentence. Nothing implies a causal or temporal relationship between signals ("X while Y") that wasn't actually verified — they're just the real, individual facts, listed.

## API

`GET /api/radar?window=<seconds>&limit=<n>`

```json
{
  "windowSeconds": 1800,
  "count": 1,
  "radar": [
    {
      "token": "0x...",
      "symbol": "MEME",
      "name": "...",
      "radarScore": 78,
      "fletchScore": 84,
      "riskLevel": "LOW",
      "topSignal": { "type": "WHALE_BUY_FROM_CURVE", "severity": "HIGH", "...": "..." },
      "whyNow": ["A large buy came directly off the bonding curve.", "Holder count increased since the last check."],
      "distinctSignalTypes": 2,
      "convergenceMultiplier": 1.15,
      "lastSignalAt": 1730000000,
      "metrics": { "holderCount": 312, "liquidityUsd": 41800, "buyCountWindow": 18, "sellCountWindow": 3 },
      "dataAvailability": { "symbol": "REAL", "fletchScore": "REAL" }
    }
  ]
}
```

Sorted by `radarScore` descending. `fletchScore`/`riskLevel` are `null` (with `dataAvailability.fletchScore: "NOT_ENOUGH_HISTORY"`) for a token that has signals but hasn't been snapshotted yet — real fields, honestly empty, never fabricated.

## Not built in this pass

- **True acceleration baselines.** Radar's recency decay is a simple linear function of signal age, not a comparison against the token's own historical signal rate — same limitation already noted for `ACTIVITY_ACCELERATION` in [SIGNALS.md](./SIGNALS.md).
- **New-launch activity threshold beyond "has a signal."** The spec's example ("new launch + zero activity is not interesting") is satisfied structurally (no signals = not a candidate), but there's no additional minimum-activity bar beyond the existing signal-detection thresholds already documented in SIGNALS.md.
- **Radar history.** Nothing persists a token's radar score over time yet — it's computed fresh on every request from the same underlying signals/snapshots. Adding that would be a small, contained addition (one more read, no new write) if it turns out to matter.
