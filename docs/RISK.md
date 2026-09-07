# Risk intelligence

`src/risk/riskAnalysis.ts`

## Levels

`LOW` / `MEDIUM` / `HIGH` / `CRITICAL` — never a bare "SCAM" label. Every finding is an `{ level, evidence }` pair; `evidence` always names the actual number behind the flag ("top 10 holders own 82% of tracked supply", not "high concentration").

The token's overall level is the highest level among its findings. A numeric concern count (sum of each finding's level weight) also feeds `safetyScore` (0–100, higher = safer), which is what the FLETCH Score's Safety component uses directly — no re-derivation.

## What's checked today

**At launch** (from the Pons V2 factory/curve event data — ported from GTTM's `huntScore.ts`, which called this pattern-matching on read-only chain data, not prediction):

| Finding | Trigger | Level |
|---|---|---|
| Large dev buy | dev bought >5% of curve-sold supply | HIGH |
| Moderate dev buy | dev bought 1–5% | MEDIUM |
| Bundled wallets | 3+ wallets declared exempt from opening snipe tax | HIGH |
| Bundled wallets | 1–2 wallets exempt | MEDIUM |
| Serial deployer | 5+ launches from this deployer in the scanned window | HIGH |
| Serial deployer | 2–4 launches | MEDIUM |
| Self-exempted dev | dev's own buy paid less than the standard opening tax | MEDIUM |

**Ongoing** (from live holder/liquidity metrics — new in FLETCH, GTTM only ever looked at launch moment for one token):

| Finding | Trigger | Level |
|---|---|---|
| Extreme concentration | top 10 tracked accumulators hold >70% | CRITICAL |
| High concentration | 50–70% | HIGH |
| Elevated concentration | 35–50% | MEDIUM |
| Very thin liquidity | under $5,000 | HIGH |
| Thin liquidity | $5,000–$20,000 | MEDIUM |

A token with none of the above gets exactly one `LOW` finding stating "no red flags found" — the risk list is never empty, so the UI always has something to show rather than silently implying "not checked."

## What the brief names that isn't implemented yet

Mint permissions, ownership renouncement, blacklist functionality, and transfer restrictions all require reading and interpreting arbitrary token bytecode/ABI — meaningfully different work from event-log analysis (needs either bytecode pattern-matching against known malicious templates, or a contract-analysis service). Not built in this MVP. Anything FLETCH doesn't check is simply absent from the findings list — it does **not** silently count as "checked and fine."

## Design principle

Every risk finding is: a stated evidence string, a level chosen by explicit numeric thresholds (all in `riskAnalysis.ts`, nothing hidden), and reproducible from the same chain data the rest of the app reads. Tests for every threshold live in `src/risk/riskAnalysis.test.ts`.
