# FLETCH — production image (API + dashboard + monitoring poller in one process).
# Node 22 is required: FLETCH uses the built-in node:sqlite module.

# ---- build ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

# ---- run ----
FROM node:22-slim
ENV NODE_ENV=production \
    PORT=8787 \
    DB_PATH=/data/fletch.db \
    TRUST_PROXY=1
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY web ./web
# /data is where the persistent volume is mounted (launch registry, balances,
# trades, reports). Without a volume everything is rebuilt after each deploy.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8787
# Liveness only — deliberately no chain read, so a slow/rate-limited RPC
# never makes the platform restart a healthy process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]
