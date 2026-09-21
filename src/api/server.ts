import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../core/config.js";
import { pingChain, type ChainPingResult } from "../chain/client.js";
import { RpcChainDataProvider } from "../data/providers/rpcProvider.js";
import { scanRecentLaunches, devBuyPercentOfCurveSupply } from "../chain/hunt.js";
import { readTokenInfo } from "../chain/token.js";
import { getSmartMoneyForToken } from "../wallets/smartMoney.js";
import { getSocialSignalForToken } from "../social/social.js";
import { getWalletIntelligence } from "../wallets/walletScore.js";
import { explainWhyItsMoving } from "../ai/explain.js";
import { analyzeAndPersist } from "../signals/signalService.js";
import { pickTopSignal } from "../signals/types.js";
import { getSnapshotHistory } from "../persistence/snapshots.js";
import { getRecentSignals, getSignalsForToken } from "../persistence/signalsStore.js";
import { getRadar } from "../radar/radarService.js";
import { RADAR_WINDOW_SECONDS_DEFAULT } from "../radar/radarEngine.js";
import { getMonitoringHealth } from "../monitoring/monitoringStore.js";
import { countSnapshotsSince } from "../persistence/snapshots.js";
import { countSignalsSince } from "../persistence/signalsStore.js";
import { bigIntSafe, errorMessage } from "./jsonSafe.js";

const provider = new RpcChainDataProvider();

/**
 * Extracted from the /api/health handler so it can be unit-tested
 * directly with a fake bigint-bearing ChainPingResult, without needing a
 * live RPC connection to exercise pingChain()'s success path (the test
 * suite runs with RPC_URL unset, so it never naturally reaches that
 * branch — see api/server.test.ts for exactly this test). This is the
 * literal function the real handler calls, not a re-implementation.
 */
export function buildHealthResponse(chain: ChainPingResult, blockscoutConfigured: boolean, pollerEnabled: boolean) {
  return { ok: chain.ok, chain: bigIntSafe(chain), blockscoutConfigured, pollerEnabled };
}

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

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
      res.status(500).json({ error: errorMessage(e) });
    });
  };
}

export function createServer(options?: { rateLimit?: { windowMs: number; limit: number } }) {
  const app = express();
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

  app.get("/api/health", asyncRoute(async (_req, res) => {
    const chain = await pingChain();
    res.json(buildHealthResponse(chain, config.hasBlockscout(), config.enablePoller));
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
    const launches = await scanRecentLaunches(windowBlocks);
    const limited = launches.slice(0, 50); // cap: full metrics per token is several RPC round-trips

    const rows = await Promise.all(
      limited.map(async (launch) => {
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
      })
    );

    rows.sort((a, b) => (b.fletchScore ?? -1) - (a.fletchScore ?? -1));
    res.json({ count: rows.length, tokens: rows });
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

  // Full token intelligence page.
  app.get("/api/tokens/:address", asyncRoute(async (req, res) => {
    const address = req.params.address as `0x${string}`;
    const info = await readTokenInfo(address);

    if (!info.contractExists) {
      res.status(404).json({ error: `No contract found at ${address} on Robinhood Chain (chain ID ${config.chainId}).` });
      return;
    }

    const metrics = await provider.getTokenMetrics(address);

    const launches = await scanRecentLaunches(50_000n);
    const launch = launches.find((l) => l.token.toLowerCase() === address.toLowerCase()) ?? null;

    const smartMoney = await getSmartMoneyForToken(address);
    const social = await getSocialSignalForToken(address);
    const { risk, score, signals } = analyzeAndPersist(address, launch, metrics, smartMoney, social);
    const why = explainWhyItsMoving(signals, risk);

    res.json({
      token: { address, symbol: info.symbol, name: info.name, contractExists: info.contractExists },
      metrics: bigIntSafe(metrics),
      risk,
      fletchScore: score,
      signals,
      whyIsItMoving: why,
      smartMoney,
      social,
      dataAvailability: {
        liquidity: metrics.liquidityUsd !== null ? "REAL" : "UNAVAILABLE",
        holders: metrics.holderCount !== null ? "REAL" : "UNAVAILABLE",
        whaleActivity: metrics.holderCount !== null ? "REAL" : "UNAVAILABLE",
        smartMoney: smartMoney.available ? "REAL" : "NOT_YET_IMPLEMENTED",
        social: social.available ? "REAL" : "NOT_YET_IMPLEMENTED",
        postGraduationPricing: "NOT_YET_IMPLEMENTED",
        blockscoutAcceleration: config.hasBlockscout() ? "REAL" : "REQUIRES_API_KEY",
      },
    });
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
    res.json({ address, signals: getSignalsForToken(address, limit) });
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
    res.json(getWalletIntelligence(address));
  }));

  return app;
}
