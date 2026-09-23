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
- **Backups:** the whole state is `/data/fletch.db`. Railway volumes support
  backups from the volume's settings; or download it with the Railway CLI.
- **Cost:** the Hobby plan (about $5/month, usage-based — check Railway's
  current pricing) covers one small service + a 1 GB volume.
- **Restarts** are safe: SIGTERM closes the DB cleanly, and the poller resumes
  from stored coverage — no chain history is re-read.
