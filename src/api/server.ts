import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../core/config.js";
import { pingChain } from "../chain/client.js";
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

const provider = new RpcChainDataProvider();

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export function createServer() {
  const app = express();
  app.use(cors());
  app.use(express.json());

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

  app.get("/api/health", async (_req, res) => {
    const chain = await pingChain();
    res.json({ ok: chain.ok, chain, blockscoutConfigured: config.hasBlockscout(), pollerEnabled: config.enablePoller });
  });

  // Is FLETCH actually watching the chain right now? See
  // monitoring/monitoringStore.ts and docs/MONITORING.md. Never exposes
  // RPC_URL or any other secret — only counts and timestamps.
  app.get("/api/monitoring", async (_req, res) => {
    try {
      const now = Math.floor(Date.now() / 1000);
      const health = getMonitoringHealth(now);
      res.json({
        enabled: config.enablePoller,
        discoveryIntervalMs: config.discoveryIntervalMs,
        pollIntervalMs: config.pollIntervalMs,
        maxConcurrentTokens: config.maxConcurrentTokens,
        maxMonitoredTokens: config.maxMonitoredTokens,
        ...health,
        snapshotsLastHour: countSnapshotsSince(now - 3600),
        signalsLastHour: countSignalsSince(now - 3600),
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "unknown error" });
    }
  });

  // Early Signals feed — new tokens, scored.
  app.get("/api/tokens", async (req, res) => {
    try {
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
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "unknown error" });
    }
  });

  // Chain-wide live signal feed — events worth attention, not a token list.
  // Sorted by severity then recency (see persistence/signalsStore.ts).
  app.get("/api/signals", async (req, res) => {
    try {
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
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "unknown error" });
    }
  });

  // Meme Radar — what's starting to move right now, ranked by recency-
  // weighted signal convergence, not by FLETCH Score or size. See
  // radar/radarEngine.ts and docs/RADAR.md. Entirely persistence-driven
  // (no live chain scan needed to rank); only symbol/name resolution
  // touches the chain client, best-effort.
  app.get("/api/radar", async (req, res) => {
    try {
      const windowSeconds = req.query.window ? Math.max(60, Number(req.query.window)) : RADAR_WINDOW_SECONDS_DEFAULT;
      const limit = req.query.limit ? Math.min(100, Number(req.query.limit)) : 25;
      const radar = await getRadar(windowSeconds);
      res.json({ windowSeconds, count: radar.length, radar: radar.slice(0, limit) });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "unknown error" });
    }
  });

  // Full token intelligence page.
  app.get("/api/tokens/:address", async (req, res) => {
    try {
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
        metrics,
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
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "unknown error" });
    }
  });

  // Snapshot history — "how has this token's score evolved?"
  app.get("/api/tokens/:address/history", async (req, res) => {
    try {
      const address = req.params.address as `0x${string}`;
      const limit = req.query.limit ? Math.min(500, Number(req.query.limit)) : 50;
      res.json({ address, snapshots: getSnapshotHistory(address, limit) });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "unknown error" });
    }
  });

  // Signal timeline for one token.
  app.get("/api/tokens/:address/signals", async (req, res) => {
    try {
      const address = req.params.address as `0x${string}`;
      const limit = req.query.limit ? Math.min(200, Number(req.query.limit)) : 50;
      res.json({ address, signals: getSignalsForToken(address, limit) });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "unknown error" });
    }
  });

  // Wallet activity for a token — see data/providers/rpcProvider.ts for the
  // honest scope limitation (per-token accumulation, not cross-token history).
  app.get("/api/tokens/:address/wallets", async (req, res) => {
    try {
      const address = req.params.address as `0x${string}`;
      const activity = await provider.getWalletActivity(address);
      res.json({ address, wallets: activity });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "unknown error" });
    }
  });

  // Wallet-level intelligence — see wallets/walletScore.ts for exactly what's
  // real (participation record) vs. NOT_YET_IMPLEMENTED (PnL, win rate).
  app.get("/api/wallets/:address", async (req, res) => {
    try {
      const address = req.params.address as `0x${string}`;
      res.json(getWalletIntelligence(address));
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "unknown error" });
    }
  });

  return app;
}
