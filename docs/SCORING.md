# The FLETCH Score

`src/scoring/fletchScore.ts`

## Components

| Component | Weight | Source | Real today? |
|---|---|---|---|
| Momentum | 0.25 | buy/sell counts in the scan window | yes |
| Smart Money | 0.20 | cross-token wallet performance history | no — [unavailable](./DATA.md#smart-money) |
| Social | 0.15 | mentions / sentiment | no — [unavailable](./DATA.md#social) |
| Liquidity | 0.15 | curve's own quote-asset balance, converted to USD | yes (pre-graduation only) |
| Holder Growth | 0.15 | holder count from a full `Transfer` log replay | yes (count, not yet growth *rate* — see below) |
| Safety | 0.10 | inverted risk score from `risk/riskAnalysis.ts` | yes |

## The rule: only weight what's available

Each component is either a number or an explicit `null` with a reason (`ComponentScore.reason`). The overall score **re-normalizes weights across only the available components** rather than treating a missing one as zero (which would unfairly tank every score until Smart Money and Social are built) or as some neutral default (which would be a fabricated number wearing a real one's clothes).

```ts
const totalWeight = available.reduce((s, [k]) => s + WEIGHTS[k], 0);
for (const [k, c] of available) {
  const normalizedWeight = WEIGHTS[k] / totalWeight;
  overall += c.value * normalizedWeight;
}
```

`weightsUsed` on the returned `FletchScore` records exactly which components fed the number and at what re-normalized weight — that's what a "why did this score change" explanation would diff against once score history is persisted (not implemented yet — see [DEVELOPMENT.md](./DEVELOPMENT.md)).

## Component formulas, as they exist today

**Momentum** — `null` if there's been zero buy/sell activity in the window. Otherwise a blend of buy-side pressure (`buyCount / totalCount`) and a log-scaled activity level, so a token with heavy two-sided trading isn't penalized as hard as a "no activity yet" token, but isn't purely ranked by raw volume either.

**Liquidity** — `null` with a stated reason (e.g. "graduated to v4, not readable yet" or "USD feed unavailable") whenever `liquidityUsd` isn't resolvable. Otherwise log-scaled: $0 → 0, ~$100k+ → 100, so early liquidity growth still moves the needle instead of everything under $10k reading as zero.

**Holder Growth** — currently scores *absolute* holder count (log-scaled), not a growth rate, because there's no snapshot history store to diff against yet. This is named honestly in the code and the dashboard rather than implying a trend exists — see the "Not built yet" note below.

**Safety** — passed through directly from `RiskReport.safetyScore` (100 minus a weighted concern count from `risk/riskAnalysis.ts`) — no re-derivation.

## Not built yet

- **Real holder-growth rate.** Needs periodic snapshots persisted somewhere (a database), then a diff between two points in time. Right now "Holder Growth" is an honest proxy for "how many holders, on a log scale" — see [DATA.md](./DATA.md) for what closes this gap.
- **Smart Money and Social components.** Both are stubbed to `unavailable` — see [DATA.md](./DATA.md#smart-money) and [DATA.md](./DATA.md#social) for exactly what's missing.
