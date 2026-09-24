# Deploying FLETCH (Railway)

FLETCH is one long-running Node 22 process: API + dashboard + the monitoring
poller, with its data in a SQLite file. It needs a host that keeps the
process running and gives it a **persistent disk** — so not Vercel (the
landing page in `site/` stays on Vercel; the app runs here).

The repo ships everything Railway needs: `Dockerfile`, `.dockerignore`,
`railway.json` (Dockerfile build, `/healthz` health check, restart on failure).

## 1. Create the service
1. Sign in at [railway.com](https://railway.com) with GitHub.
2. **New Project → Deploy from GitHub repo →** pick `FLETCH`.
   Railway finds `railway.json` and builds the `Dockerfile`. Every `git push`
   to `main` redeploys.

## 2. Add the persistent volume
In the service: **+ New → Volume** (or right-click the service → *Attach
volume*), mount path **`/data`**, 1 GB is plenty. The image already points
`DB_PATH` at `/data/fletch.db`. Without the volume, the launch registry,
holder balances, trades and reports are rebuilt from scratch on every deploy.

## 3. Set variables
Service → **Variables**:

| Variable | Value | Why |
|---|---|---|
| `RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` | Robinhood Chain's public RPC — no key |
| `ENABLE_POLLER` | `true` | continuous discovery + monitoring |
| `LOG_SCAN_CHUNK_BLOCKS` | `10000` | the public RPC serves 50k-block log ranges in one call |
| `MAX_CONCURRENT_TOKENS` | `3` | what the public RPC sustains |
| `RAILWAY_RUN_UID` | `0` | Railway mounts volumes owned by root; the image runs as a non-root user, so without this FLETCH logs `unable to open database file` |

Already set by the image — don't add: `PORT` (Railway overrides it and FLETCH
reads it), `DB_PATH=/data/fletch.db`, `TRUST_PROXY=1` (rate limits per visitor,
not per Railway proxy). No `ANTHROPIC_API_KEY`: FLETCH AI chat is bring-your-own-key
in the browser.

## 4. Check it
Service → **Settings → Networking → Generate Domain** gives
`<something>.up.railway.app`. Open:
- `/healthz` → `{"ok":true}` (liveness; no chain read)
- `/api/health` → `"chain":{"ok":true,…}`
- `/api/monitoring` → `totalMonitored` climbing after a few minutes
- `/` → the dashboard

## 5. Custom domain
**Settings → Networking → Custom Domain →** `app.getfletch.xyz`. Railway shows
a **CNAME** target; add that record at your domain registrar (host `app`,
value = the target). HTTPS is issued automatically once DNS resolves.

## Operating notes
- **Logs:** service → *Deployments → View logs* — the same lines as locally
  (`Discovery: …`, `Monitoring: checked …`, one line per RPC pause).
- **Backups** — the whole state is `/data/fletch.db`. Three layers, cheapest first:
  1. **Snapshots on the volume (automatic).** FLETCH writes a consistent copy
     (`VACUUM INTO`) to `/data/backups/fletch-<UTC time>.db` 10 minutes after
     start and then every `BACKUP_INTERVAL_HOURS` (24), keeping the newest
     `BACKUP_KEEP` (3). Protects against a bad migration or a corrupted file,
     not against losing the volume. `GET /api/health` shows `backup.lastSnapshotAt`.
  2. **Railway volume backups.** Service → **Backups** → *Edit schedule* →
     tick **Daily** (kept 6 days) and **Weekly** (kept a month). Restore from
     the same tab: Railway mounts the restored volume in place of the old one.
  3. **A copy off Railway.** Set `BACKUP_TOKEN` to a long random string
     (`openssl rand -hex 24`), then from your own machine:
     ```bash
     curl -fsS -H "Authorization: Bearer $BACKUP_TOKEN" \
       -o "fletch-$(date +%F).db" https://app.getfletch.xyz/api/admin/backup
     ```
     Without the token the route answers 404, same as a route that doesn't exist.
  - **Restoring a snapshot by hand:** stop the service, replace `/data/fletch.db`
    with the snapshot file, start it again.
- **Cost:** the Hobby plan (about $5/month, usage-based — check Railway's
  current pricing) covers one small service + a 1 GB volume.
- **Restarts** are safe: SIGTERM closes the DB cleanly, and the poller resumes
  from stored coverage — no chain history is re-read.
