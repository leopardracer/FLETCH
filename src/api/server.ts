import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../core/config.js";
import { pingChain } from "../chain/client.js";
import { RpcChainDataProvider } from "../data/providers/rpcProvider.js";
import { scanRecentLaunches, devBuyPercentOfCurveSupply } from "../chain/hunt.js";
import { readTokenInfo } from "../chain/token.js";
import { analyzeRisk } from "../risk/riskAnalysis.js";
import { computeFletchScore } from "../scoring/fletchScore.js";
import { getSmartMoneyForToken } from "../wallets/smartMoney.js";
import { getSocialSignalForToken } from "../social/social.js";
import { explainWhyItsMoving } from "../ai/explain.js";

const provider = new RpcChainDataProvider();

export function createServer() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const webDir = path.resolve(__dirname, "../../web");
  app.use(express.static(webDir));

  app.get("/api/health", async (_req, res) => {
    const chain = await pingChain();
    res.json({ ok: chain.ok, chain, blockscoutConfigured: config.hasBlockscout() });
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
          const risk = analyzeRisk(launch, metrics);
          const smartMoney = await getSmartMoneyForToken(launch.token);
          const social = await getSocialSignalForToken(launch.token);
          const score = metrics ? computeFletchScore(metrics, risk, smartMoney, social) : null;
          const info = await readTokenInfo(launch.token).catch(() => null);

          return {
            token: launch.token,
            symbol: info?.symbol ?? null,
            deployer: launch.deployer,
            launchBlock: launch.launchBlock.toString(),
            devBuyPercent: devBuyPercentOfCurveSupply(launch.devBuyTokens),
            riskLevel: risk.level,
            fletchScore: score?.overall ?? null,
          };
        })
      );

      rows.sort((a, b) => (b.fletchScore ?? -1) - (a.fletchScore ?? -1));
      res.json({ count: rows.length, tokens: rows });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "unknown error" });
    }
  });

  // Full token intelligence page.
  app.get("/api/tokens/:address", async (req, res) => {
    try {
      const address = req.params.address as `0x${string}`;
      const [info, metrics] = await Promise.all([readTokenInfo(address), provider.getTokenMetrics(address)]);

      const launches = await scanRecentLaunches(50_000n);
      const launch = launches.find((l) => l.token.toLowerCase() === address.toLowerCase()) ?? null;

      const risk = analyzeRisk(launch, metrics);
      const smartMoney = await getSmartMoneyForToken(address);
      const social = await getSocialSignalForToken(address);
      const score = computeFletchScore(metrics, risk, smartMoney, social);
      const why = explainWhyItsMoving(metrics, risk, score);

      res.json({
        token: { address, symbol: info.symbol, name: info.name, contractExists: info.contractExists },
        metrics,
        risk,
        fletchScore: score,
        whyIsItMoving: why,
        smartMoney,
        social,
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "unknown error" });
    }
  });

  return app;
}
