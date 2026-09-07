# The FLETCH Score

`src/scoring/fletchScore.ts`

## Components

| Component | Weight | Source | Real today? |
|---|---|---|---|
| Momentum | 0.22 | buy/sell counts in the scan window | yes |
| Smart Money | 0.16 | cross-token wallet performance history | no — [unavailable](./DATA.md#smart-money) |
| Social | 0.12 | mentions / sentiment | no — [unavailable](./DATA.md#social) |
| Liquidity | 0.14 | curve's own quote-asset balance, converted to USD | yes (pre-graduation only) |
| Holder Growth | 0.14 | real % change since the last snapshot, when one exists; otherwise an absolute-count proxy | yes, upgraded in Phase 2 — see below |
| Whale Activity | 0.12 | large transfers classified against the token's curve address | yes — new in Phase 2 |
| Safety | 0.10 | inverse of the risk report | yes |

Weights don't have to sum to the brief's suggested numbers exactly — they were re-derived after inspecting what's actually measurable per component (see the rationale inline in `fletchScore.ts`). They do sum to 1.00.

## The rule: only weight what's available

Each component is either a number or an explicit `null` with a reason (`ComponentScore.reason`). The overall score **re-normalizes weights across only the available components** rather than treating a missing one as zero (which would unfairly tank every score until Smart Money and Social are built) or as some neutral default (which would be a fabricated number wearing a real one's clothes).

```ts
const totalWeight = available.reduce((s, [k]) => s + WEIGHTS[k], 0);
for (const [k, c] of available) {
  const normalizedWeight = WEIGHTS[k] / totalWeight;
  overall += c.value * normalizedWeight;
}
```

`weightsUsed` on the returned `FletchScore` records exactly which components fed the number and at what re-normalized weight.

## Component formulas, as they exist today

**Momentum** — `null` if there's been zero buy/sell activity in the window. Otherwise a blend of buy-side pressure (`buyCount / totalCount`) and a log-scaled activity level.

**Liquidity** — `null` with a stated reason (e.g. "graduated to v4, not readable yet") whenever `liquidityUsd` isn't resolvable. Otherwise log-scaled: $0 → 0, ~$100k+ → 100.

**Holder Growth** — *(upgraded in Phase 2)*. When a previous snapshot exists (within the comparison window persistence provides — see [SIGNALS.md](./SIGNALS.md)), this is a real percentage: 0% change → 50 (neutral), +50% or more → 100, −50% or more → 0, clamped. The label states the exact before/after counts and percentage. Without a previous snapshot, it falls back to the original log-scaled absolute-count proxy, and the label says so explicitly ("no history yet, showing count not growth rate") — never silently presented as a rate it isn't.

**Whale Activity** — *(new in Phase 2)*. `null` only when the underlying holder/transfer scan itself failed (`holderCount === null`) — genuinely unknown, not zero. A successful scan with zero whale-threshold transfers is real information ("checked, found none") and scores a defined neutral 50. When whale transfers exist and the token's curve address is known, moves are classified as buy-from-curve or sell-to-curve by weight; the score leans toward 90 when buys dominate, 30 when sells dominate. Undirected transfers (neither into nor out of the curve — ambiguous wallet-to-wallet moves) nudge the score up only mildly and are capped at 65, since intent isn't known.

**Safety** — passed through directly from `RiskReport.safetyScore` — no re-derivation.

## Not built yet

- **Smart Money and Social components** — both stubbed to `unavailable`. See [DATA.md](./DATA.md#smart-money) and [DATA.md](./DATA.md#social).
- **A true baseline for Holder Growth beyond one snapshot back** — the current comparison is always against the single most recent snapshot older than the comparison window, not a longer trend line. `GET /api/tokens/:address/history` exposes the raw snapshot history if you want to compute your own longer-window trend client-side.
