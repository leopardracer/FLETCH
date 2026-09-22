<p align="center">
  <img src="./assets/banner.png" alt="FLETCH — meme intelligence for Robinhood Chain" width="100%">
</p>

<p align="center">
  <a href="https://github.com/leopardracer/FLETCH/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/leopardracer/FLETCH/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="tests" src="https://img.shields.io/badge/tests-331%20passing-D9316A?style=flat-square&labelColor=15050A">
  <img alt="coverage" src="https://img.shields.io/badge/coverage-87.24%25-D9316A?style=flat-square&labelColor=15050A">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522.6-F5E8EC?style=flat-square&labelColor=15050A">
  <img alt="chain" src="https://img.shields.io/badge/chain-4663-F5E8EC?style=flat-square&labelColor=15050A">
  <img alt="runtime deps" src="https://img.shields.io/badge/runtime%20deps-7-F5E8EC?style=flat-square&labelColor=15050A">
  <img alt="fabricated data" src="https://img.shields.io/badge/fabricated%20data-0-D9316A?style=flat-square&labelColor=15050A">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-F5E8EC?style=flat-square&labelColor=15050A">
</p>

<p align="center"><b>The meme moves first. FLETCH tells you why.</b></p>

---

Meme tokens on Robinhood Chain launch by the thousand, and most of what "moves" is noise. FLETCH is the intelligence layer that reads the chain directly — launches, trades, holders, liquidity, deployer behavior — and turns it into three plain-English answers: what's happening, why, and whether it's worth your attention. Every number is either a real chain read or explicitly marked `unavailable`. Nothing here is a fabricated demo dressed up as a live product.

FLETCH is **not** a token screener, a trading bot, or a price predictor. There is no execution path in this repository — an optional, read-only chat agent exists (off by default, see [docs/AI.md](./docs/AI.md)), but it can only report what FLETCH's own deterministic engine already found; it can't trade, and it won't predict price or tell you whether something is "safe to buy."

<details open>
<summary><b>Contents</b></summary>

**What & why** — [What is FLETCH?](#what-is-fletch) · [How it works](#how-it-works) · [Watch it run](#watch-it-run)

**Product** — [Early Signals](#early-signals) · [Signal Engine](#signal-engine) · [Continuous Monitoring](#continuous-monitoring) · [Meme Radar](#meme-radar) · [FLETCH Score](#fletch-score) · [Why is it moving?](#why-is-it-moving) · [Risk Intelligence](#risk-intelligence) · [Smart Money](#smart-money) · [AI Layer](#ai-layer)

**Using it** — [Architecture](#architecture) · [Quick Start](#quick-start) · [Live Data](#live-data) · [Demo](#demo)

**Contributing** — [Tests](#tests) · [Development](#development) · [Roadmap](#roadmap) · [Built on](#built-on) · [License](#license)

</details>

## What is FLETCH?

A discovery feed, a risk engine, and an explanation layer, all reading the same source of truth: Pons V2 launch and trade events on Robinhood Chain.

| The problem | What FLETCH does |
|---|---|
| Hundreds of new tokens a day, most of them noise | Ranks by **FLETCH Score** — an explainable blend of momentum, liquidity, holders, and safety — not by market cap |
| "Is this a bundle / bot / bot-farm launch?" | Reads the launch transaction itself: dev-buy %, wallets exempted from the opening snipe tax, serial-deployer count — see [docs/RISK.md](./docs/RISK.md) |
| "Why is this moving right now?" | A templated explanation built directly from the structured numbers FLETCH computed — never a free-form model call touching raw data — see [docs/SIGNALS.md](./docs/SIGNALS.md) |
| Dashboards that quietly fake the numbers they can't get | Smart Money and Social components render `UNAVAILABLE` with a stated reason instead of a plausible-looking guess — see [docs/DATA.md](./docs/DATA.md) |
| "Trust me, it's risky" | Every risk finding names its evidence — `top 10 holders own 82%`, not `high risk` |

## How it works

```mermaid
flowchart LR
    A[Robinhood Chain<br/>Pons V2 launches + trades] --> B[Data Provider]
    B --> C[Risk Engine]
    B --> D[Signal Detection]
    C --> E[FLETCH Score]
    D --> E
    E --> F[AI Explanation]
    C --> F
    E --> G[API]
    F --> G
    B --> G
    G --> H[Dashboard]
```

Full breakdown, including why the data-provider boundary exists and what it unlocks later: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Watch it run

<p align="center">
  <img src="./assets/watch-it-run.gif" alt="Real terminal output: FLETCH booting the API and responding to two real requests" width="100%">
</p>

Real terminal output — `npm run dev` booting the actual API, then two real requests against it: a health check, and a malformed address. No RPC connection is configured in this capture, and FLETCH says exactly that instead of pretending otherwise. That's the whole point of the project.

> **FLETCH starts with the chain, not the chart.**

Launches, trades, holders, liquidity, and whale activity are read directly off Robinhood Chain — not scraped, not estimated. Those reads feed a risk engine and a signal engine that run on every check, and both feed into the FLETCH Score. None of that is optional or mocked: turn off `RPC_URL` and the app tells you so, the way it just did above, instead of drawing a chart from nothing.

The pipeline, in order:

**launch → trades → holders → liquidity → wallets → signals → risk → score**

The full diagram is above, in [How it works](#how-it-works). The exact rule for each stage — what counts as a signal, what triggers a risk finding, how the score is weighted — is written down in [docs/SIGNALS.md](./docs/SIGNALS.md), [docs/RISK.md](./docs/RISK.md), and [docs/SCORING.md](./docs/SCORING.md).

Point it at a live RPC endpoint and the dashboard screenshots itself: `npm run screenshot` (see [Quick Start](#quick-start)) captures the real, populated UI once there's real chain activity to show. Nothing here was staged with fake tokens to look more impressive.

## Early Signals

The discovery feed scans the Pons V2 factory for every `TokenLaunched` event and ranks by FLETCH Score — not market cap, not recency. Age, dev-buy %, risk level, and score all come from the same real chain reads.

```
TOKEN       AGE     DEV BUY   RISK      FLETCH SCORE
```
*(shape shown — see [Live Data](#live-data) below; this repo doesn't ship fabricated rows to fill that table in.)*

Details on what counts as a signal today: [docs/SIGNALS.md](./docs/SIGNALS.md).

## Signal Engine

Beyond the discovery feed, FLETCH runs a real signal engine (`src/signals/signalEngine.ts`) that detects buy/sell pressure, whale moves classified against the token's own curve address, and — once snapshot history exists — holder growth, liquidity change, price movement, activity acceleration, and phase transitions (curve → graduated). Every signal has a type, severity, confidence, exact evidence, and a plain explanation; trend signals never fire without a real previous snapshot to compare against. The dashboard's **Signals** tab shows the live, chain-wide feed — events worth attention, not a token list. Full breakdown: [docs/SIGNALS.md](./docs/SIGNALS.md).

## Continuous Monitoring

FLETCH doesn't wait for someone to open a token page. A durable, prioritized monitoring queue (a SQLite table, survives restart) discovers new launches on a bounded scan, then checks whatever's due with bounded concurrency — new launches and tokens with recent signals get checked often, quiet ones less so. A check that fails never writes fake data: only the queue's own failure count and last error change, and a token failing repeatedly is marked FAILED and stops being scheduled, so one broken address can't retry forever. History is pruned on a retention schedule so storage stays bounded. Every real check still goes through the same signal engine and `analyzeAndPersist()` the API already uses — this is scheduling and bounding, not a second signal system. `GET /api/monitoring` shows whether it's actually running. Full breakdown, including the priority model and what's honestly not built yet: [docs/MONITORING.md](./docs/MONITORING.md).

## Meme Radar

> **THE CHAIN MOVES FIRST. FLETCH FINDS IT.**

<p align="center">
  <img src="./assets/radar-race.gif" alt="DEMO — six example tokens racing on Radar score as signals arrive; not real chain data" width="100%">
</p>

*DEMO — six invented example tokens, not real addresses or real signal history. The mechanism is real (recency-weighted convergence, see below); the race itself is illustrative shape only, same as every other `DEMO`-labeled block in this README — see [Demo](#demo).*

The Tokens feed ranks by FLETCH Score. Radar ranks by something different: how much is changing *right now*. A token with a mediocre score can top Radar because buy pressure just accelerated, a whale just bought off the curve, and holders just started growing — all at once. That convergence is the point: one signal type firing repeatedly scores the same as it firing once, but two or three distinct kinds of signal firing together get a real multiplier. Recency matters too — a signal from two minutes ago outweighs an identical one from two hours ago, and past a 30-minute window it stops counting at all.

Risk is never hidden by momentum. Every Radar entry shows its risk level next to the score, plainly — Radar is a ranking system, not a buy signal.

Ranking needs no live chain call: candidates and scores come straight from persisted signals and snapshots (`GET /api/radar`). Full formula, with every constant spelled out: [docs/RADAR.md](./docs/RADAR.md).

## FLETCH Score

Six components, each either a real number or an explicit `null` with a reason. The overall score re-weights across only the components that are actually available for a given token — a token isn't punished for Smart Money and Social not existing yet.

*DEMO — illustrative shape only, not a real token's output.*

**`$ARROWCAT` — FLETCH SCORE `91`**

| Component | Score | Why |
|---|---|---|
| Momentum | 96 | buy pressure + activity level, since launch |
| Smart Money | `UNAVAILABLE` | no cross-token wallet history store yet |
| Holders | 91 | +42% since the last check (real, once history exists) |
| Liquidity | 82 | curve balance, converted to USD |
| Whale Activity | 78 | 3 whale buys from the curve, no sells |
| Safety | 71 | inverse of the risk report |

Exact formulas, weight re-normalization, and what "not yet a growth rate" means for Holder Growth: [docs/SCORING.md](./docs/SCORING.md).

## Why is it moving?

Every bullet traces back to a number FLETCH already computed — buy/sell counts, holder count, liquidity, risk findings. This is deliberately **not** a free-form LLM call: the safest way to guarantee the brief's "AI must never invent blockchain data" rule is to never let generated text see raw numbers and write from scratch. See `src/ai/explain.ts` and its test file for exactly what that means in code.

Optionally, `?summary=ai` on the token endpoint rephrases these same bullets into one plain-English paragraph — same "never see raw numbers, only rephrase what's already computed" rule, via a real LLM call this time. Off by default (needs `ANTHROPIC_API_KEY`); the deterministic bullets above are always present either way. Full writeup, plus the read-only chat agent built on the same principle: [docs/AI.md](./docs/AI.md).

```
DEMO — illustrative shape only

WHY IS IT MOVING?
  18 buys vs 3 sells since launch
  312 holders tracked (lifetime)
  liquidity currently $41,800
  smart-money activity: unavailable (no wallet history store yet)

RISK
  [HIGH] top 10 holders own 61% of tracked supply
  [MEDIUM] liquidity is $41,800 — thin
```

## Risk Intelligence

`LOW` / `MEDIUM` / `HIGH` / `CRITICAL`, never a bare "SCAM." Launch-moment checks (dev buy, bundled wallets, serial deployer) plus ongoing checks (holder concentration, liquidity depth, trend-based findings). Full threshold table and what isn't checked yet (mint permissions, blacklist functions — needs bytecode analysis, not built): [docs/RISK.md](./docs/RISK.md).

## Smart Money

Per wallet, real: every curve buy/sell recorded with its exact price-at-trade, and from that realized PnL, unrealized PnL, win rate and early-entry timing — each computed only over history FLETCH saw gap-free from launch, and `UNAVAILABLE` with a reason otherwise (`GET /api/wallets/:address`). Not yet: a cross-wallet "smart money" ranking in the FLETCH Score (`src/wallets/smartMoney.ts` stays unavailable until enough real closed positions accumulate to rank). See [docs/DATA.md](./docs/DATA.md#smart-money).

## AI Layer

**FLETCH AI** is built into every view: a live **market brief** on the home page, an **AI analyst** card on every token page, an **AI wallet read** on every wallet page, and **Ask FLETCH AI** — a chat with five read-only tools, reachable from every page. All of it is **rephrase/report**, never **generate**: the model never sees raw chain data, never predicts, and never tells anyone what to buy. Runs on the operator's `ANTHROPIC_API_KEY`, or on the visitor's own key in the browser. Full details: [docs/AI.md](./docs/AI.md). The pieces underneath:

- **Natural-language summary** (`GET /api/tokens/:address?summary=ai`) rephrases the same deterministic bullets from [Why is it moving?](#why-is-it-moving) into one paragraph — same "never see raw numbers, only rephrase what's already computed" rule, via a real LLM call. Needs the operator's `ANTHROPIC_API_KEY`.
- **Chat agent** (`POST /api/chat`) answers questions about a token or wallet by calling FLETCH's own real functions as tools and reporting back only what they returned — the same `getTokenIntel()` the token API itself calls, so the agent can't report a different number than the dashboard does. Also needs the operator's key.
- **Chat, bring your own key** (the dashboard's **Chat** tab) — same agent, but the Anthropic call happens straight from your browser tab with a key you paste in yourself. FLETCH's server never sees it. No server-side `ANTHROPIC_API_KEY` needed for this path at all; the operator only needs `RPC_URL` configured, since the tool calls still read real chain data through FLETCH's own API.

The two server-side features degrade to "field omitted" / "chat not configured" without a key, rather than throwing or faking a response. Full writeup: [docs/AI.md](./docs/AI.md).

## Architecture

`chain/` (raw Robinhood Chain + Pons V2 reads) → `data/` (the `ChainDataProvider` abstraction) → `persistence/` (SQLite snapshot/signal history) + `risk/` + `signals/` + `scoring/` + `ai/` (pure, unit-tested logic where possible) → `api/` (Express) → `web/` (dashboard).

The `ChainDataProvider` interface is the seam that lets a Bitquery-backed provider (unlocks post-graduation Uniswap v4 pricing, decoded trade history, wallet tracking) get swapped in later without touching scoring, risk, or the API. The signal engine (`signals/signalEngine.ts`) is a pure function over metrics + risk + an optional previous snapshot — no chain calls, no DB access, fully unit-tested. Full writeup: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Quick Start

Every command below is a real script in [`package.json`](./package.json) — nothing here is invented.

```sh
git clone https://github.com/leopardracer/FLETCH.git
cd FLETCH
npm install
cp .env.example .env
# edit .env — at minimum, set RPC_URL (see .env.example for where to get one)
npm run dev
# open http://localhost:8787
```

`RPC_URL` is required — there's no default baked in, on purpose (see `src/core/config.ts`). Full environment variable reference and what each optional one unlocks: [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md).

## Live Data

FLETCH reads Robinhood Chain directly — no seed data, no fixtures shipped in the repo. What's real today versus what's `unavailable` and why: [docs/DATA.md](./docs/DATA.md). Short version:

**Real:** new-token discovery, launch risk signals, holder counts + whale moves, pre-graduation liquidity/price, buy/sell activity, FLETCH Score (Momentum/Liquidity/Holder Growth/Whale Activity/Safety), risk levels with evidence, persisted snapshot + signal history, trend-based signals and risk findings once history exists.

**Explicitly unavailable, not faked:** post-graduation (Uniswap v4) pricing, Smart Money win-rate/PnL (the participation record is real; PnL isn't — see [docs/DATA.md](./docs/DATA.md#smart-money)), Social signal.

## Demo

Every `DEMO`-labeled block above is illustrative shape, not real output — this repo doesn't ship a screenshot gallery built from fabricated tokens. To see real output: run [Quick Start](#quick-start) against a live `RPC_URL`, or generate real dashboard screenshots yourself with `npm run screenshot` (needs Playwright — see `scripts/screenshot.mjs` for why that's a separate install rather than a project dependency).

## Tests

<p align="center">
  <img src="./assets/tests-terminal.gif" alt="FLETCH test suite — 218 passing, 82.18% line coverage, clean build" width="100%">
</p>

FLETCH's test suite covers the parts of the product where correctness actually matters: every FLETCH Score formula, every risk-finding threshold, every signal type the signal engine can emit, the persistence layer that backs all of it, and the API surface end-to-end over real HTTP. All of it runs deterministically — no live RPC calls, no real database file, no wall-clock timing — using Node's built-in test runner and `node:sqlite`'s in-memory mode, so a run is exact and reproducible every time.

```sh
npm test
```

```
tests 331
pass 331
fail 0
```

```sh
npm run test:coverage
```

```
all files   |  87.24 |    87.05 |   73.31 |
```

87.24% line coverage on real application code (test files themselves excluded from that number). Core business logic — signal detection, risk analysis, scoring, persistence, wallet intelligence, the "why is it moving" explainer, the AI rephrase layer, and the chat agent's tool-use loop — sits at 90–100%. The lower spots are `chain/*.ts`, `data/providers/rpcProvider.ts`, and `intel/tokenIntel.ts`, which genuinely need a live RPC connection to exercise meaningfully, plus `ai/client.ts`, which needs a real `ANTHROPIC_API_KEY`; per this project's own rule against fabricating chain data (and, now, fabricated AI responses), none of those are mocked into a false 100%. See [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md#tests) for the full breakdown and the reasoning file by file.

```sh
npm run test:integration   # the five test files that exercise multiple layers together —
                            # chain metrics → risk → score → signals → persistence, discovery
                            # → monitoring queue → bounded checks, Radar ranking, and a
                            # real Express app over real HTTP
npm run test:watch         # re-runs on every change to the compiled output
```

## Development

Setup, environment variables, and the current next-steps list: [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md).

```sh
npm run dev
```

Type-checks, builds, and starts the API + dashboard. `npm run build` does the first two only.

## Roadmap

<details>
<summary>Priority order, 9 items — click to expand (detailed in <a href="./docs/DEVELOPMENT.md#next-steps">docs/DEVELOPMENT.md</a>)</summary>

1. Verify the Blockscout provider against a live API key; wire it into the feed to cut per-token RPC round-trips
2. ~~Thread each token's launch timestamp into the signal engine so activity acceleration compares against a true baseline, not just the last snapshot~~ — **done**
3. Evaluate Bitquery for Uniswap v4 pricing and decoded trade history — a provider swap, not a rewrite
4. ~~Record price-at-trade in wallet activity — the specific piece blocking real Smart Money PnL/win-rate~~ — **done**: real realized PnL and win rate per wallet, see [docs/DATA.md](./docs/DATA.md#smart-money)
5. Decide on a social data source, or keep it honestly unavailable
6. Wallet-clustering detection off existing transfer data
7. ~~Batch per-launch RPC calls via multicall~~ — **done, opt-in**: set a verified `MULTICALL3_ADDRESS`
8. ~~Automatic reactivation of a `FAILED` monitored token after a cool-off~~ — **done**, plus RPC rate-limit backoff that never penalizes tokens
9. A real DETECTED→STRENGTHENING→FADING signal lifecycle, if the simpler existing per-snapshot dedup turns out not to be enough in practice

</details>

## Built on

| Source | What was used |
|---|---|
| [docs.robinhood.com/chain](https://docs.robinhood.com/chain/) | RPC endpoint, chain ID, network model |
| [Bitquery's Pons launchpad docs](https://docs.bitquery.io/docs/blockchain/robinhood/pons-api/) | cross-verification for the Pons V2 contract addresses and event signatures |
| [Blockscout](https://robinhoodchain.blockscout.com) | official Robinhood Chain explorer; optional holder-count acceleration API |

FLETCH is independent of Pons and Robinhood, refers to the network as "Robinhood Chain," and uses none of their marks.

## License

MIT — see [LICENSE](./LICENSE).
