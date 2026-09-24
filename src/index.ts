import { config } from "./core/config.js";
import { createServer } from "./api/server.js";
import { startPoller } from "./poller/poller.js";
import { closeDb } from "./persistence/db.js";
import { runBackup, backupDir } from "./persistence/backup.js";

const app = createServer();
let stopPoller: () => void = () => {};

const server = app.listen(config.port, () => {
  console.log(`FLETCH API listening on :${config.port}`);
  if (!config.rpcUrl) {
    console.warn("RPC_URL is not set — every chain-reading endpoint will error until it is. See .env.example.");
  }
  if (!config.hasBlockscout()) {
    console.warn("BLOCKSCOUT_API_KEY is not set — running on raw RPC log scanning only (works, just slower at scale).");
  }
  if (config.rpcUrl) stopPoller = startPoller(); // no RPC_URL means every poll tick would just fail — don't bother starting it
  startBackups();
});

/** Daily database snapshot (persistence/backup.ts): first one 10 minutes after start, then every BACKUP_INTERVAL_HOURS. */
let backupTimer: ReturnType<typeof setTimeout> | undefined;
function startBackups(): void {
  if (!(config.backupIntervalHours > 0) || !backupDir()) return;
  const tick = () => {
    try {
      const r = runBackup();
      if (r) console.log(`Backup: ${r.file} (${(r.bytes / 1e6).toFixed(1)} MB)${r.removed.length ? `, removed ${r.removed.length} old` : ""}.`);
    } catch (e) {
      console.error("Backup failed:", e instanceof Error ? e.message : e);
    }
    backupTimer = setTimeout(tick, config.backupIntervalHours * 3600 * 1000);
    backupTimer.unref();
  };
  backupTimer = setTimeout(tick, 10 * 60 * 1000);
  backupTimer.unref();
}

/**
 * Closes cleanly on SIGTERM (the signal a process manager/container
 * runtime sends before killing a process) and SIGINT (Ctrl-C in a
 * terminal): stop scheduling new poller ticks, stop accepting new HTTP
 * connections, then close the SQLite file so its journal isn't left in a
 * half-written state. Without this, a deploy/restart just kills the
 * process mid-write — usually harmless with SQLite's WAL mode, but not
 * guaranteed, and node:sqlite is still labeled experimental (see
 * persistence/db.ts) so there's no reason to rely on that.
 */
function shutdown(signal: string): void {
  console.log(`${signal} received — shutting down...`);
  stopPoller();
  if (backupTimer) clearTimeout(backupTimer);
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  // Force-exit if something (a stuck in-flight request) keeps the server
  // from closing on its own within a reasonable window.
  setTimeout(() => {
    console.warn("Shutdown timed out waiting for in-flight requests — forcing exit.");
    closeDb();
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
