import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { config } from "../core/config.js";
import { pingChain, type ChainPingResult } from "../chain/client.js";
import { RpcChainDataProvider } from "../data/providers/rpcProvider.js";
import { scanRecentLaunches, devBuyPercentOfCurveSupply } from "../chain/hunt.js";
import { readTokenInfo } from "../chain/token.js";
import { getSmartMoneyForToken } from "../wallets/smartMoney.js";
import { getSocialSignalForToken } from "../social/social.js";
import { getWalletIntelligence } from "../wallets/walletScore.js";
import { getTokenIntel } from "../intel/tokenIntel.js";
import { analyzeAndPersist } from "../signals/signalService.js";
import { pickTopSignal } from "../signals/types.js";
import { getSnapshotHistory } from "../persistence/snapshots.js";
import { getRecentSignals, getSignalsForToken, getSignalsForTokenSince } from "../persistence/signalsStore.js";
import { computeLifecycles } from "../signals/lifecycle.js";
import { getRadar } from "../radar/radarService.js";
import { RADAR_WINDOW_SECONDS_DEFAULT } from "../radar/radarEngine.js";
import { getMonitoringHealth, getMonitoredToken } from "../monitoring/monitoringStore.js";
import { countSnapshotsSince } from "../persistence/snapshots.js";
import { countSignalsSince } from "../persistence/signalsStore.js";
import { bigIntSafe, errorMessage } from "./jsonSafe.js";
import { rpcBackoff, isRpcRateLimitError, type RpcBackoffState } from "../core/rpcBackoff.js";
import { getReport, listReports } from "../persistence/reportStore.js";
import type { Signal } from "../signals/types.js";
import { rephraseSummary, rephraseFacts } from "../ai/rephrase.js";
import { buildMarketBrief, type MarketBrief } from "../ai/brief.js";
import { buildWalletFacts } from "../ai/walletExplain.js";
import type { WhyIsItMoving } from "../ai/explain.js";
import { runChatAgent, createDefaultAgentDeps } from "../ai/chatAgent.js";

const provider = new RpcChainDataProvider();

/**
 * Extracted from the /api/health handler so it can be unit-tested
 * directly with a fake bigint-bearing ChainPingResult, without needing a
 * live RPC connection to exercise pingChain()'s success path (the test
 * suite runs with RPC_URL unset, so it never naturally reaches that
 * branch — see api/server.test.ts for exactly this test). This is the
 * literal function the real handler calls, not a re-implementation.
 */
export function buildHealthResponse(
  chain: ChainPingResult,
  blockscoutConfigured: boolean,
  pollerEnabled: boolean,
  rpcBackoffState?: RpcBackoffState
) {
  return {
    ok: chain.ok,
    chain: bigIntSafe(chain),
    blockscoutConfigured,
    pollerEnabled,
    ...(rpcBackoffState ? { rpcBackoff: rpcBackoffState } : {}),
  };
}

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

// Capped at 20 turns / 4000 chars each — enough for a real conversation,
// bounded so one request can't blow up the tool-use loop's token usage.
const chatRequestSchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(4000) }))
    .min(1)
    .max(20),
});

/**
 * Every route below is async and needs the exact same error handling:
 * catch whatever it throws/rejects with and return a clean 500 with
 * { error: message } instead of an unhandled rejection (Express 4 doesn't
 * catch those on its own — see the /api/health comment above for why that
 * matters). This used to be a `try { ... } catch (e: any) { res.status(500)
 * .json({ error: e?.message ?? "unknown error" }) }` repeated verbatim in
 * all ten handlers; wrapping the handler once here is the same behavior
 * with one copy of the catch instead of ten.
 */
function asyncRoute(
  handler: (req: express.Request, res: express.Response) => Promise<void>
): express.RequestHandler {
  return (req, res) => {
    handler(req, res).catch((e: unknown) => {
      // Found live on the public RPC: a provider rate limit surfaced as a
      // generic 500, indistinguishable from a real bug. It's a temporary,
      // retryable condition — say so, with a Retry-After.
      if (isRpcRateLimitError(e)) {
        res.status(503).set("Retry-After", "30").json({ error: "The chain RPC is rate-limiting FLETCH right now — try again in a moment.", retryable: true });
        return;
      }
      res.status(500).json({ error: errorMessage(e) });
    });
  };
}

/** Runs `fn` over `items` with at most `limit` in flight — keeps a burst of chain reads under an RPC's rate limit. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** How long the live token feed (GET /api/tokens) is reused before re-reading the chain. */
const FEED_CACHE_SECONDS = 90;
/** A stored report this fresh is served as-is instead of re-reading the chain. */
const REPORT_FRESH_SECONDS = 300;
/** The cached feed only lists tokens whose report is at most this old. */
const FEED_REPORT_MAX_AGE_SECONDS = 3 * 3600;

/** How long a computed market brief is reused before the radar/signal feed is re-read. */
const BRIEF_CACHE_SECONDS = 120;
/** How long a token page's deterministic "why is it moving" stays available to /ai-summary. */
const WHY_CACHE_SECONDS = 900;

export function createServer(options?: {
  rateLimit?: { windowMs: number; limit: number };
  chatRateLimit?: { windowMs: number; limit: number };
}) {
  const app = express();
  if (config.trustProxy > 0) app.set("trust proxy", config.trustProxy);
  app.use(cors());
  app.use(express.json());

  // Bounds request volume per IP before it can turn into unbounded RPC
  // load on /api/tokens and friends — see core/config.ts for the
  // (generous, local-dev-safe) defaults. Static dashboard assets below
  // are unaffected; this only wraps /api/*. Overridable per-instance (see
  // `options`) purely so api/server.test.ts can exercise the actual 429
  // path against a dedicated, short-lived server instead of the shared
  // one every other test in that file also hits.
  const rl = options?.rateLimit ?? { windowMs: config.rateLimitWindowMs, limit: config.rateLimitMax };
  app.use(
    "/api",
    rateLimit({
      windowMs: rl.windowMs,
      limit: rl.limit,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many requests — slow down." },
    })
  );

  // Stricter cap on the one endpoint that can spend the server's own LLM key
  // per request (the brief and summaries are cached; chat can't be).
  const crl = options?.chatRateLimit ?? { windowMs: config.chatRateLimitWindowMs, limit: config.chatRateLimitMax };
  const chatLimiter = rateLimit({
    windowMs: crl.windowMs,
    limit: crl.limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many AI chat messages — try again in a few minutes." },
  });

  // Per-instance caches (never module-global, so tests stay isolated).
  let briefCache: { at: number; brief: MarketBrief } | null = null;
  const whyCache = new Map<string, { at: number; why: WhyIsItMoving }>();
  const feedCache = new Map<string, { at: number; body: unknown }>();

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const webDir = path.resolve(__dirname, "../../web");
  app.use(express.static(webDir));

  // Applies to every route with an :address param (tokens, wallets) — one
  // place to reject a malformed address with a clear, specific message
  // instead of letting it reach viem and produce a raw, unfriendly error.
  app.param("address", (req, res, next, value) => {
    if (!ADDRESS_RE.test(value)) {
      res.status(400).json({ error: `Invalid address: "${value}" — expected a 20-byte hex address like 0x1234...abcd` });
      return;
    }
    next();
  });

  // Liveness for the hosting platform: the process is up and serving. No chain
  // read on purpose — a slow RPC must never get a healthy process restarted.
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/health", asyncRoute(async (_req, res) => {
    const chain = await pingChain();
    res.json(buildHealthResponse(chain, config.hasBlockscout(), config.enablePoller, rpcBackoff.state(Math.floor(Date.now() / 1000))));
  }));

  // Is FLETCH actually watching the chain right now? See
  // monitoring/monitoringStore.ts and docs/MONITORING.md. Never exposes
  // RPC_URL or any other secret — only counts and timestamps.
  app.get("/api/monitoring", asyncRoute(async (_req, res) => {
    const now = Math.floor(Date.now() / 1000);
    const health = getMonitoringHealth(now);
    const rpcConfigured = !!config.rpcUrl;
    res.json({
      enabled: config.enablePoller,
      rpcConfigured,
      // `enabled` only reflects the ENABLE_POLLER config flag — the poller
      // (see index.ts) also refuses to start at all without RPC_URL, since
      // every check would just fail. `running` is the actual truth of
      // whether anything is watching right now; the dashboard shows this,
      // not `enabled` alone, to avoid claiming FLETCH is watching when it
      // never started.
      running: config.enablePoller && rpcConfigured,
      discoveryIntervalMs: config.discoveryIntervalMs,
      pollIntervalMs: config.pollIntervalMs,
      maxConcurrentTokens: config.maxConcurrentTokens,
      maxMonitoredTokens: config.maxMonitoredTokens,
      ...health,
      snapshotsLastHour: countSnapshotsSince(now - 3600),
      signalsLastHour: countSignalsSince(now - 3600),
    });
  }));

  // Early Signals feed — new tokens, scored.
  app.get("/api/tokens", asyncRoute(async (req, res) => {
    const windowBlocks = req.query.window ? BigInt(String(req.query.window)) : undefined;
    // Found live: 50 tokens × full live metrics took 193s on the public RPC.
    // The feed now reads 20 tokens live and is cached for FEED_CACHE_SECONDS,
    // so a busy page never re-triggers hundreds of chain reads.
    const cacheKey = String(windowBlocks ?? "default");
    const cached = feedCache.get(cacheKey);
    if (cached && Date.now() / 1000 - cached.at < FEED_CACHE_SECONDS) {
      res.json(cached.body);
      return;
    }
    // Preferred path: the monitoring queue has already analyzed these tokens —
    // build the feed from stored reports, zero chain reads, instant.
    if (windowBlocks === undefined && req.query.live !== "1") {
      const since = Math.floor(Date.now() / 1000) - FEED_REPORT_MAX_AGE_SECONDS;
      const reps = listReports(since, 200);
      if (reps.length >= 5) {
        const rows = reps
          .map((r) => {
            const rep = r.report as { token?: { symbol?: string | null }; fletchScore?: { overall?: number | null }; risk?: { level?: string }; signals?: Signal[] };
            const m = getMonitoredToken(r.token as `0x${string}`);
            return {
              token: r.token,
              symbol: rep.token?.symbol ?? null,
              deployer: m?.launch?.deployer ?? null,
              launchBlock: m?.launch ? String(m.launch.launchBlock) : null,
              devBuyPercent: m?.launch ? devBuyPercentOfCurveSupply(m.launch.devBuyTokens) : null,
              riskLevel: rep.risk?.level ?? null,
              fletchScore: rep.fletchScore?.overall ?? null,
              topSignal: rep.signals && rep.signals.length ? pickTopSignal(rep.signals) : null,
              asOf: r.takenAt,
            };
          })
          .sort((a, b) => (b.fletchScore ?? -1) - (a.fletchScore ?? -1))
          .slice(0, 50);
        const body = { count: rows.length, tokens: rows, source: "cache" };
        res.json(body);
        return;
      }
    }
    const launches = await scanRecentLaunches(windowBlocks, 20);
    const limited = launches; // already limited to the 20 newest before enrichment

    // 3 at a time, not all at once: firing every token's reads in parallel is
    // what tripped the public RPC's rate limit and left all 50 rows unscored.
    const rows = await mapLimit(limited, 3, async (launch) => {
        const metrics = await provider.getTokenMetrics(launch.token).catch(() => null);
        const smartMoney = await getSmartMoneyForToken(launch.token);
        const social = await getSocialSignalForToken(launch.token);
        const analysis = metrics ? analyzeAndPersist(launch.token, launch, metrics, smartMoney, social) : null;
        const info = await readTokenInfo(launch.token).catch(() => null);

        return {
          token: launch.token,
          symbol: info?.symbol ?? null,
          deployer: launch.deployer,
          launchBlock: launch.launchBlock.toString(),
          devBuyPercent: devBuyPercentOfCurveSupply(launch.devBuyTokens),
          riskLevel: analysis?.risk.level ?? null,
          fletchScore: analysis?.score.overall ?? null,
          topSignal: analysis ? pickTopSignal(analysis.signals) : null,
        };
      });

    rows.sort((a, b) => (b.fletchScore ?? -1) - (a.fletchScore ?? -1));
    const body = { count: rows.length, tokens: rows, cachedForSeconds: FEED_CACHE_SECONDS };
    feedCache.set(cacheKey, { at: Date.now() / 1000, body });
    res.json(body);
  }));

  // Chain-wide live signal feed — events worth attention, not a token list.
  // Sorted by severity then recency (see persistence/signalsStore.ts).
  app.get("/api/signals", asyncRoute(async (req, res) => {
    const limit = req.query.limit ? Math.min(200, Number(req.query.limit)) : 50;
    const signals = getRecentSignals(limit);
    const uniqueTokens = [...new Set(signals.map((s) => s.token))];
    const symbolByToken = new Map<string, string | null>();
    await Promise.all(
      uniqueTokens.map(async (t) => {
        const info = await readTokenInfo(t as `0x${string}`).catch(() => null);
        symbolByToken.set(t, info?.symbol ?? null);
      })
    );
    res.json({
      count: signals.length,
      signals: signals.map((s) => ({ ...s, symbol: symbolByToken.get(s.token) ?? null })),
    });
  }));

  // Meme Radar — what's starting to move right now, ranked by recency-
  // weighted signal convergence, not by FLETCH Score or size. See
  // radar/radarEngine.ts and docs/RADAR.md. Entirely persistence-driven
  // (no live chain scan needed to rank); only symbol/name resolution
  // touches the chain client, best-effort.
  app.get("/api/radar", asyncRoute(async (req, res) => {
    const windowSeconds = req.query.window ? Math.max(60, Number(req.query.window)) : RADAR_WINDOW_SECONDS_DEFAULT;
    const limit = req.query.limit ? Math.min(100, Number(req.query.limit)) : 25;
    const radar = await getRadar(windowSeconds);
    res.json({ windowSeconds, count: radar.length, radar: radar.slice(0, limit) });
  }));

  // Full token intelligence page. Pass ?summary=ai to also get a
  // natural-language rephrase of whyIsItMoving (src/ai/rephrase.ts) —
  // opt-in and omitted by default so a normal page view never pays the
  // extra LLM latency/cost, and never changes the shape of the plain
  // response existing callers already depend on.
  app.get("/api/tokens/:address", asyncRoute(async (req, res) => {
    const address = req.params.address as `0x${string}`;
    const now = Math.floor(Date.now() / 1000);
    const stored = getReport(address);
    const fresh = stored && now - stored.takenAt < REPORT_FRESH_SECONDS && req.query.live !== "1";

    let body: Record<string, unknown>;
    let why: WhyIsItMoving;
    if (fresh) {
      // Computed by monitoring (or a view) within the last few minutes — no chain reads.
      body = { ...stored!.report, source: "cache", asOf: stored!.takenAt };
      why = stored!.report.whyIsItMoving as WhyIsItMoving;
    } else {
      try {
        const info = await readTokenInfo(address);
        if (!info.contractExists) {
          res.status(404).json({ error: `No contract found at ${address} on Robinhood Chain (chain ID ${config.chainId}).` });
          return;
        }
        const intel = await getTokenIntel(address, info, provider);
        body = { ...(bigIntSafe(intel) as unknown as Record<string, unknown>), source: "live", asOf: now };
        why = intel.whyIsItMoving;
      } catch (e: unknown) {
        // Rate-limited with an older report on file: serve it, clearly marked stale.
        if (stored && isRpcRateLimitError(e)) {
          body = { ...stored.report, source: "cache", stale: true, asOf: stored.takenAt };
          why = stored.report.whyIsItMoving as WhyIsItMoving;
        } else throw e;
      }
    }
    // Kept briefly so the dashboard's AI analyst card (GET .../ai-summary)
    // can rephrase exactly these facts without a second round of chain reads.
    if (whyCache.size > 1000) whyCache.clear();
    whyCache.set(address.toLowerCase(), { at: Math.floor(Date.now() / 1000), why });

    if (req.query.summary === "ai") {
      body.naturalLanguageSummary = await rephraseSummary(why);
    }

    res.json(body);
  }));

  // AI analyst card for a token page: rephrases the SAME deterministic
  // whyIsItMoving the page just loaded — no second chain read, no new facts.
  // Needs the token to have been opened recently (GET /api/tokens/:address).
  app.get("/api/tokens/:address/ai-summary", asyncRoute(async (req, res) => {
    const now = Math.floor(Date.now() / 1000);
    const cached = whyCache.get(req.params.address.toLowerCase());
    if (!cached || now - cached.at > WHY_CACHE_SECONDS) {
      res.status(404).json({ error: "No fresh FLETCH report for this token — load GET /api/tokens/:address first." });
      return;
    }
    res.json({ aiEnabled: config.hasAnthropic(), naturalLanguageSummary: await rephraseSummary(cached.why) });
  }));

  // Snapshot history — "how has this token's score evolved?"
  app.get("/api/tokens/:address/history", asyncRoute(async (req, res) => {
    const address = req.params.address as `0x${string}`;
    const limit = req.query.limit ? Math.min(500, Number(req.query.limit)) : 50;
    res.json({ address, snapshots: getSnapshotHistory(address, limit) });
  }));

  // Signal timeline for one token.
  app.get("/api/tokens/:address/signals", asyncRoute(async (req, res) => {
    const address = req.params.address as `0x${string}`;
    const limit = req.query.limit ? Math.min(200, Number(req.query.limit)) : 50;
    const now = Math.floor(Date.now() / 1000);
    const lifecycleWindow = RADAR_WINDOW_SECONDS_DEFAULT;
    res.json({
      address,
      signals: getSignalsForToken(address, limit),
      // Per signal type: DETECTED / STRENGTHENING / STEADY / FADING / RESOLVED — see signals/lifecycle.ts.
      lifecycleWindowSeconds: lifecycleWindow,
      lifecycle: computeLifecycles(getSignalsForTokenSince(address, now - 3 * lifecycleWindow), now, lifecycleWindow),
    });
  }));

  // Wallet activity for a token — see data/providers/rpcProvider.ts for the
  // honest scope limitation (per-token accumulation, not cross-token history).
  app.get("/api/tokens/:address/wallets", asyncRoute(async (req, res) => {
    const address = req.params.address as `0x${string}`;
    const activity = await provider.getWalletActivity(address);
    res.json({ address, wallets: activity });
  }));

  // Wallet-level intelligence — see wallets/walletScore.ts for exactly what's
  // real (participation record) vs. NOT_YET_IMPLEMENTED (PnL, win rate).
  app.get("/api/wallets/:address", asyncRoute(async (req, res) => {
    const address = req.params.address as `0x${string}`;
    const intel = getWalletIntelligence(address);
    if (req.query.summary === "ai") {
      const facts = buildWalletFacts(intel);
      res.json({ ...intel, aiFacts: facts, naturalLanguageSummary: await rephraseFacts(facts, "wallet") });
      return;
    }
    res.json(intel);
  }));

  // Is the server-side AI (chat, brief, summaries) configured? Lets the
  // dashboard use server chat when it is, and offer BYOK when it isn't.
  // Never reveals the key or the model config beyond the model name.
  app.get("/api/ai", (_req, res) => {
    res.json({ enabled: config.hasAnthropic(), model: config.hasAnthropic() ? config.anthropicModel : null });
  });

  // FLETCH AI Market Brief — one paragraph on what's happening across
  // Robinhood Chain right now, rephrased from Radar + the signal feed +
  // monitoring counts (src/ai/brief.ts). Cached briefly: a busy homepage
  // re-reads the feed at most every BRIEF_CACHE_SECONDS.
  app.get("/api/brief", asyncRoute(async (_req, res) => {
    const now = Math.floor(Date.now() / 1000);
    if (!briefCache || now - briefCache.at > BRIEF_CACHE_SECONDS) {
      const windowSeconds = 3600;
      const [radar, signals] = await Promise.all([getRadar(windowSeconds).catch(() => []), Promise.resolve(getRecentSignals(200))]);
      const brief = await buildMarketBrief({
        radar,
        signals,
        monitoredTokens: getMonitoringHealth(now).totalMonitored,
        windowSeconds,
        now,
      });
      briefCache = { at: now, brief };
    }
    res.json({ aiEnabled: config.hasAnthropic(), ...briefCache.brief });
  }));

  // Chat agent — answers questions about tokens/wallets by calling the
  // same real deterministic functions the rest of the API uses
  // (src/ai/chatAgent.ts). Returns a plain "not configured" reply if
  // ANTHROPIC_API_KEY is unset, same as every other AI feature here.
  app.post("/api/chat", chatLimiter, asyncRoute(async (req, res) => {
    const parsed = chatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Expected { messages: [{ role: 'user'|'assistant', content: string }] }, 1-20 messages.",
      });
      return;
    }

    const result = await runChatAgent(parsed.data.messages, createDefaultAgentDeps());
    res.json(result);
  }));

  return app;
}
