import { config } from "./core/config.js";
import { createServer } from "./api/server.js";
import { startPoller } from "./poller/poller.js";

const app = createServer();
app.listen(config.port, () => {
  console.log(`FLETCH API listening on :${config.port}`);
  if (!config.rpcUrl) {
    console.warn("RPC_URL is not set — every chain-reading endpoint will error until it is. See .env.example.");
  }
  if (!config.hasBlockscout()) {
    console.warn("BLOCKSCOUT_API_KEY is not set — running on raw RPC log scanning only (works, just slower at scale).");
  }
  if (config.rpcUrl) startPoller(); // no RPC_URL means every poll tick would just fail — don't bother starting it
});
