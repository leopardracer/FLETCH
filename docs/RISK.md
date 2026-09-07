# Risk intelligence

`src/risk/riskAnalysis.ts`

## Levels

`LOW` / `MEDIUM` / `HIGH` / `CRITICAL` — never a bare "SCAM" label. Every finding is a `{ level, code, evidence }` triple; `code` is a stable identifier (see below) and `evidence` always names the actual number behind the flag.

The token's overall level is the highest level among its findings. A numeric concern count also feeds `safetyScore` (0–100, higher = safer), which the FLETCH Score's Safety component uses directly.

## Finding codes

Each finding carries a `RiskFindingCode` — this is what lets the signal engine promote risk findings into signals 1:1 (see [SIGNALS.md](./SIGNALS.md)) without parsing evidence text.

**At launch** (from the Pons V2 factory/curve event data — ported from GTTM's `huntScore.ts`):

| Code | Trigger | Level |
|---|---|---|
| `DEV_BUY` | dev bought >5% of curve-sold supply | HIGH |
| `DEV_BUY` | dev bought 1–5% | MEDIUM |
| `BUNDLED_WALLETS` | 3+ wallets declared exempt from opening snipe tax | HIGH |
| `BUNDLED_WALLETS` | 1–2 wallets exempt | MEDIUM |
| `SERIAL_DEPLOYER` | 5+ launches from this deployer in the scanned window | HIGH |
| `SERIAL_DEPLOYER` | 2–4 launches | MEDIUM |
| `REDUCED_DEV_TAX` | dev's own buy paid less than the standard opening tax | MEDIUM |

**Ongoing, point-in-time** (from live holder/liquidity/whale metrics):

| Code | Trigger | Level |
|---|---|---|
| `HOLDER_CONCENTRATION` | top 10 tracked accumulators hold >70% | CRITICAL |
| `HOLDER_CONCENTRATION` | 50–70% | HIGH |
| `HOLDER_CONCENTRATION` | 35–50% | MEDIUM |
| `THIN_LIQUIDITY` | liquidity under $5,000 | HIGH |
| `THIN_LIQUIDITY` | $5,000–$20,000 | MEDIUM |
| `WHALE_DUMPING` *(new)* | 3+ whale-sized transfers into the curve (selling) in the scan window | HIGH |
| `WHALE_DUMPING` *(new)* | 1–2 such transfers | MEDIUM |

**Ongoing, trend-based** *(new — only fire with a real previous snapshot; see [SIGNALS.md](./SIGNALS.md) on the comparison window)*:

| Code | Trigger | Level |
|---|---|---|
| `LIQUIDITY_DETERIORATION` | liquidity dropped >30% since the last check | HIGH |
| `LIQUIDITY_DETERIORATION` | dropped 15–30% | MEDIUM |
| `ABNORMAL_SELL_PRESSURE` | sells since the last check outnumber buys 4:1+, with at least 3 sells | HIGH |
| `ABNORMAL_SELL_PRESSURE` | outnumber 2:1–4:1 | MEDIUM |

A token with none of the above gets exactly one `LOW` finding with code `CLEAN` — the risk list is never empty.

## What the brief names that isn't implemented yet

Mint permissions, ownership renouncement, blacklist functionality, and transfer restrictions all require reading and interpreting arbitrary token bytecode/ABI — meaningfully different work from event-log analysis. Not built. Anything FLETCH doesn't check is simply absent from the findings list — it does **not** silently count as "checked and fine."

## Design principle

Every risk finding is: a stated evidence string, a level chosen by explicit numeric thresholds (all in `riskAnalysis.ts`), and reproducible from the same chain data (and, for trend findings, the same persisted snapshot) the rest of the app reads. Tests for every threshold, including the new trend-based ones, live in `src/risk/riskAnalysis.test.ts`.
