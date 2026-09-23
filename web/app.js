const API_BASE = window.FLETCH_API_BASE || ""; // same-origin by default — server.ts serves this file itself
const app = document.getElementById("app");

const NAV = [
  { id: "overview", label: "Overview" },
  { id: "radar", label: "Radar" },
  { id: "live-signals", label: "Signals" },
  { id: "tokens", label: "Tokens" },
  { id: "wallets", label: "Wallets" },
  { id: "risk", label: "Risk" },
  { id: "chat", label: "Ask FLETCH AI" },
  { id: "monitoring", label: "Monitoring" },
  { id: "docs", label: "Docs" },
];

function navHref(id) {
  return id === "tokens" ? "#/" : `#/${id}`;
}

function renderNav(active) {
  const bar = document.getElementById("navbar");
  if (!bar) return;
  bar.innerHTML = NAV.map(
    (n) => `<a class="navlink${n.id === active ? " active" : ""}" onclick="location.hash='${navHref(n.id)}'">${n.label}</a>`
  ).join("");
}

async function getJSON(path) {
  const res = await fetch(API_BASE + path);
  let body = null;
  try {
    body = await res.json();
  } catch {
    // response wasn't JSON at all — fall through to the generic message below
  }
  if (!res.ok) {
    const reason = body && body.error ? body.error : `HTTP ${res.status}`;
    const err = new Error(reason);
    err.status = res.status;
    throw err;
  }
  return body;
}

/**
 * HTML-escapes any text that isn't FLETCH's own markup. A token's symbol and
 * name are set by whoever deployed it — anyone can name a token
 * `<img src=x onerror=...>` — and AI text is model output. Neither may ever
 * reach innerHTML unescaped.
 */
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function fmtAddr(a) {
  if (!a) return "—";
  return a.slice(0, 6) + "…" + a.slice(-4);
}

/** Robinhood Chain mainnet explorer (Blockscout). */
const EXPLORER = "https://robinhoodchain.blockscout.com";

/** Short address → $SYMBOL, learned from any feed the page has loaded. The
 *  market brief deliberately names tokens by short address (deployer-chosen
 *  names never reach the AI); the UI swaps the symbol back in for people. */
const symbolByShort = new Map();
function learnSymbols(rows) {
  for (const r of rows || []) if (r && r.token && r.symbol) symbolByShort.set(fmtAddr(r.token).toLowerCase(), r.symbol);
}

/**
 * Escapes, then makes chain text readable: full tx hashes and addresses
 * become short explorer links, a leading [LEVEL] becomes a severity chip,
 * and known short token addresses show their $SYMBOL. Everything is escaped
 * first — this only ever wraps FLETCH's own text in known-safe markup.
 */
function richText(v) {
  let s = esc(v);
  let level = null;
  s = s.replace(/^\[(LOW|MEDIUM|HIGH|CRITICAL)\]\s*/, (_, l) => { level = l; return ""; });
  s = s.replace(/\b0x[0-9a-fA-F]{64}\b/g, (h) => `<a class="hash" href="${EXPLORER}/tx/${h}" target="_blank" rel="noopener" title="${h}">${fmtAddr(h)}</a>`);
  s = s.replace(/\b0x[0-9a-fA-F]{40}\b/g, (a) => `<a class="hash" href="${EXPLORER}/address/${a}" target="_blank" rel="noopener" title="${a}">${fmtAddr(a)}</a>`);
  s = s.replace(/\b0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}\b/g, (short) => {
    const sym = symbolByShort.get(short.toLowerCase());
    return sym ? `<span class="sym-inline" title="${short}">$${esc(sym)}</span>` : short;
  });
  return { html: s, level };
}

/** A fact as a list item: severity dot (from a [LEVEL] prefix or a level named in the text) + readable text. */
function factItem(text) {
  const r = richText(text);
  const lvl = r.level || (String(text).match(/\b(CRITICAL|HIGH|MEDIUM|LOW)\b/) || [])[1] || null;
  return `<li class="fact"><span class="why-dot ${lvl ? "sev-" + lvl : ""}"></span><span>${r.level ? severityChip(r.level) + " " : ""}${r.html}</span></li>`;
}

function fmtUsd(v) {
  if (v === null || v === undefined) return "—";
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "k";
  return "$" + Math.round(v);
}

function fmtAge(unixSeconds) {
  if (!unixSeconds) return "—";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (s < 3600) return Math.max(1, Math.floor(s / 60)) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}

function fmtTime(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function severityChip(level) {
  if (!level) return `<span class="chip na">N/A</span>`;
  return `<span class="chip ${level}">${level}</span>`;
}

/** A compact "why" line for table rows — the top signal's own explanation,
 *  never a re-derived summary. Omitted entirely when there's no signal yet,
 *  rather than showing an empty placeholder in every row. */
function whyLine(topSignal) {
  if (!topSignal) return "";
  return `<div class="why-line"><span class="why-dot sev-${topSignal.severity}"></span>${esc(topSignal.explanation)}</div>`;
}

function availabilityBadge(state) {
  const cls = state === "REAL" ? "avail-real" : state === "REQUIRES_API_KEY" ? "avail-key" : "avail-na";
  const label = state === "REQUIRES_API_KEY" ? "REQUIRES API KEY" : state === "NOT_YET_IMPLEMENTED" ? "NOT YET IMPLEMENTED" : state;
  return `<span class="avail-badge ${cls}">${label}</span>`;
}

/**
 * One consistent visual language for every "there's nothing to show"
 * moment, instead of a single grey box for everything:
 *   unavailable — a capability that needs infrastructure FLETCH doesn't
 *                  have yet (Smart Money, Social). Won't resolve on its own.
 *   pending     — real data that just hasn't accumulated yet (signal
 *                  timeline, score history on a token nobody's checked
 *                  twice). Will fill in as FLETCH keeps watching.
 *   empty       — a real check ran and genuinely found nothing right now
 *                  (no launches in this window, no risk alerts).
 *   error       — something actually broke.
 */
function stateBlock(kind, title, body) {
  // Nothing to show yet → the cat naps next to it (empty / pending only; errors stay plain).
  const cat = kind === "empty" || kind === "pending"
    ? `<div class="state-cat" aria-hidden="true"><img src="mascot.png" alt="" /><span class="zz">z</span><span class="zz z2">z</span></div>`
    : "";
  return `<div class="state-block state-${kind}${cat ? " has-cat" : ""}">${cat}<div><div class="state-title">${title}</div>${body ? `<div class="state-body">${body}</div>` : ""}</div></div>`;
}

/**
 * FLETCH AI card — one consistent look for every AI-written paragraph.
 * Always says where the text came from: the model rephrasing FLETCH's own
 * computed facts, or (no key / call failed) those facts shown as-is.
 */
function aiCard(title, summary, opts = {}) {
  const isLLM = summary && summary.source === "LLM";
  const provenance = isLLM
    ? "Written by FLETCH AI from FLETCH's own on-chain findings. No outside data, no predictions, no advice."
    : "FLETCH's own findings, shown as-is. AI rephrasing isn't configured on this instance.";
  const facts =
    opts.facts && opts.facts.length
      ? `<details class="ai-facts"><summary>What it was given</summary><ul>${opts.facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></details>`
      : "";
  // No AI on this instance: the facts ARE the content — show them as a clean,
  // scannable list (severity dots, $SYMBOLs, short explorer links) instead of
  // one run-on paragraph of the same sentences.
  const body =
    !isLLM && opts.facts && opts.facts.length
      ? `<ul class="fact-list">${opts.facts.slice(0, 8).map(factItem).join("")}</ul>`
      : `<p class="ai-text">${richText(summary ? summary.text : "").html}</p>`;
  return `
    <section class="ai-card${isLLM ? " ai-live" : ""}">
      <div class="ai-head"><img src="mascot.png" alt="" class="ai-mark" /><span>${esc(title)}</span>${isLLM ? `<span class="ai-badge">AI</span>` : `<span class="ai-badge facts">facts</span>`}</div>
      ${body}
      <div class="ai-prov">${provenance}</div>
      ${isLLM ? facts : ""}
    </section>`;
}

function aiCardLoading(title) {
  return `<section class="ai-card"><div class="ai-head"><img src="mascot.png" alt="" class="ai-mark" /><span>${esc(title)}</span></div>${loadingLine("FLETCH is reading the chain")}</section>`;
}

/** Loads the Market Brief into `slotId` — never blocks the page it sits on. */
async function loadMarketBrief(slotId) {
  const slot = document.getElementById(slotId);
  if (!slot) return;
  slot.innerHTML = aiCardLoading("FLETCH AI market brief");
  try {
    const [b] = await Promise.all([getJSON("/api/brief"), getJSON("/api/tokens").then((t) => learnSymbols(t.tokens)).catch(() => {})]);
    const el = document.getElementById(slotId);
    if (el) {
      el.innerHTML = aiCard("FLETCH AI market brief, last hour", b.summary, { facts: b.facts });
      if ((b.facts || []).some((f) => /\bCRITICAL\b/.test(f))) catAlert(el.querySelector(".ai-mark"));
    }
  } catch {
    const el = document.getElementById(slotId);
    if (el) el.innerHTML = "";
  }
}

/** A small terminal-style loading indicator — a blinking cursor, not a spinner or skeleton. */
function loadingLine(label) {
  return `<div class="loading-line"><img src="mascot.png" alt="" class="loading-cat" />${esc(label || "FLETCH is reading the chain")}<span class="cursor">▌</span></div>`;
}

async function renderLiveSignals() {
  renderNav("live-signals");
  app.innerHTML = `
    <div class="section-head">
      <div><h1>Signals</h1><p>Events worth attention across every recently launched token — sorted by severity, then recency. Not a token list.</p></div>
    </div>
    <div id="live-signals-body">${loadingLine()}</div>
  `;
  const body = document.getElementById("live-signals-body");
  try {
    const data = await getJSON("/api/signals?limit=80");
    if (!data.signals || data.signals.length === 0) {
      body.innerHTML = stateBlock("pending", "NOT ENOUGH HISTORY YET", "Signals accumulate as tokens are viewed or the background poller runs.");
      return;
    }
    body.outerHTML = `<div id="live-signals-body">${data.signals
      .map(
        (s) => `
        <div class="signal-row" onclick="location.hash='#/token/${s.token}'">
          <div class="signal-time">${fmtTime(s.timestamp)}</div>
          <div class="signal-token">${s.symbol ? "$" + esc(s.symbol) : fmtAddr(s.token)}</div>
          <div class="signal-type">${severityChip(s.severity)} <span class="signal-type-label">${s.type.replace(/_/g, " ")}</span></div>
          <div class="signal-evidence">${esc(s.evidence)}</div>
        </div>`
      )
      .join("")}</div>`;
  } catch (e) {
    body.innerHTML = stateBlock("error", "COULDN'T LOAD SIGNALS", e.message);
  }
}

function scoreBadge(score) {
  if (score === null || score === undefined) {
    return `<span class="score-badge" style="color:var(--ink-faint)">—</span>`;
  }
  return `
    <span class="score-badge">${score}</span>
    <span class="score-bar-track"><span class="score-bar-fill" style="width:${score}%"></span></span>
  `;
}

async function checkHealth() {
  const pip = document.getElementById("status-pip");
  const text = document.getElementById("status-text");
  try {
    const h = await getJSON("/api/health");
    if (h.ok) {
      pip.classList.add("ok");
      text.textContent = `live · block ${Number(h.chain.blockNumber).toLocaleString("en-US")}`;
      if (lastBlockSeen !== null && h.chain.blockNumber !== lastBlockSeen) catHop(document.querySelector(".brand-cat"));
      lastBlockSeen = h.chain.blockNumber;
    } else {
      pip.classList.add("bad");
      text.textContent = `chain unreachable: ${h.chain.reason || "check RPC_URL"}`;
    }
  } catch {
    pip.classList.add("bad");
    text.textContent = "API unreachable";
  }
}

async function renderRadar() {
  renderNav("radar");
  app.innerHTML = `
    <div class="section-head">
      <div><h1>THE CHAIN IS MOVING</h1><p>Ranked by how much is changing right now — recency-weighted signal convergence, not FLETCH Score or size. A token with no recent activity isn't ranked low, it isn't shown at all.</p></div>
    </div>
    <div id="radar-body">${loadingLine()}</div>
  `;
  const body = document.getElementById("radar-body");
  try {
    const data = await getJSON("/api/radar");
    const items = data.radar || [];
    if (items.length === 0) {
      body.innerHTML = stateBlock(
        "pending",
        "NOTHING MOVING YET",
        `No token has had a detected signal in the last ${Math.round((data.windowSeconds || 1800) / 60)} minutes. Radar fills in as tokens are checked (page views or the background poller) and produce real signals — see docs/RADAR.md.`
      );
      return;
    }
    body.innerHTML = items.map((e, i) => radarCard(e, i + 1)).join("");
  } catch (e) {
    body.innerHTML = stateBlock("error", "COULDN'T LOAD RADAR", e.message);
  }
}

/** Lifecycle stage chip — DETECTED / STRENGTHENING / STEADY / FADING / RESOLVED (signals/lifecycle.ts). */
function lifecycleChip(l) {
  if (!l) return "";
  const cls = l.stage === "STRENGTHENING" ? "HIGH" : l.stage === "DETECTED" ? "MEDIUM" : l.stage === "STEADY" ? "LOW" : "na";
  return `<span class="chip ${cls}" title="${l.recentCount} in the last window vs ${l.previousCount} in the one before">${l.stage}</span>`;
}

function radarCard(e, rank) {
  const metricBits = [];
  if (e.metrics.liquidityUsd !== null) metricBits.push(`$${e.metrics.liquidityUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })} liquidity`);
  if (e.metrics.holderCount !== null) metricBits.push(`${e.metrics.holderCount} holders`);
  if (e.metrics.buyCountWindow !== null) metricBits.push(`${e.metrics.buyCountWindow}/${e.metrics.sellCountWindow} buy/sell`);

  return `
    <div class="radar-card" onclick="location.hash='#/token/${e.token}'">
      <div class="radar-rank">${String(rank).padStart(2, "0")}</div>
      <div class="radar-body">
        <div class="radar-head">
          <span class="radar-sym">${e.symbol ? "$" + esc(e.symbol) : fmtAddr(e.token)}</span>
          <span class="radar-score-badge"><span class="radar-score-label">RADAR</span><span class="radar-score-num">${e.radarScore}</span></span>
        </div>

        <div class="radar-row">
          <span class="radar-risk-label">RISK</span>${severityChip(e.riskLevel)} ${lifecycleChip(e.topSignalLifecycle)}
          <span class="radar-fletch-label">FLETCH SCORE</span><span class="radar-fletch-num">${e.fletchScore !== null ? e.fletchScore : "—"}</span>
        </div>

        <div class="radar-signal-chips">
          ${e.topSignal ? `<span class="chip ${e.topSignal.severity}">${e.topSignal.type.replace(/_/g, " ")}</span>` : ""}
          ${e.distinctSignalTypes > 1 ? `<span class="radar-convergence">+${e.distinctSignalTypes - 1} more signal${e.distinctSignalTypes > 2 ? "s" : ""} converging (×${e.convergenceMultiplier})</span>` : ""}
        </div>

        <div class="radar-why">
          <div class="radar-why-label">WHY NOW</div>
          <ul>${e.whyNow.map((w) => `<li>${w}</li>`).join("")}</ul>
        </div>

        ${metricBits.length ? `<div class="radar-metrics">${metricBits.join(" · ")}</div>` : ""}
        <div class="radar-time">last signal ${fmtTime(e.lastSignalAt)}</div>
      </div>
    </div>`;
}

async function renderOverview() {
  renderNav("overview");
  app.innerHTML = `
    <div class="section-head">
      <div><h1>Overview</h1><p>Everything below comes from the same live feed as Tokens and Signals — filtered differently.</p></div>
    </div>
    <div id="brief-slot"></div>
    <div class="overview-grid" id="overview-body">
      <div class="panel-block"><h2>Moving now</h2>${loadingLine()}</div>
      <div class="panel-block"><h2>Risk alerts</h2>${loadingLine()}</div>
    </div>
  `;
  loadMarketBrief("brief-slot");
  try {
    const [data, signalsData] = await Promise.all([
      getJSON("/api/tokens"),
      getJSON("/api/signals?limit=6").catch(() => ({ signals: [] })),
    ]);
    const tokens = data.tokens || [];
    const movingNow = [...tokens].sort((a, b) => (b.fletchScore ?? -1) - (a.fletchScore ?? -1)).slice(0, 8);
    const alerts = tokens.filter((t) => t.riskLevel === "HIGH" || t.riskLevel === "CRITICAL").slice(0, 8);
    const recentSignals = signalsData.signals || [];

    document.getElementById("overview-body").innerHTML = `
      <div class="panel-block">
        <h2>Moving now — top FLETCH Score</h2>
        ${
          movingNow.length
            ? movingNow
                .map(
                  (t) => `<div class="mini-row" style="cursor:pointer" onclick="location.hash='#/token/${t.token}'">
                    <span class="sym">${t.symbol ? "$" + esc(t.symbol) : fmtAddr(t.token)}</span>
                    <span>${scoreBadge(t.fletchScore)}</span>
                  </div>`
                )
                .join("")
            : stateBlock("empty", "NOTHING IN THIS WINDOW", "No launches in the current scan window.")
        }
      </div>
      <div class="panel-block">
        <h2>Risk alerts — HIGH / CRITICAL</h2>
        ${
          alerts.length
            ? alerts
                .map(
                  (t) => `<div class="mini-row" style="cursor:pointer" onclick="location.hash='#/token/${t.token}'">
                    <span class="sym">${t.symbol ? "$" + esc(t.symbol) : fmtAddr(t.token)}</span>
                    <span>${severityChip(t.riskLevel)}</span>
                  </div>`
                )
                .join("")
            : stateBlock("empty", "NO ALERTS", "No elevated risk findings in the current scan window.")
        }
      </div>
      <div class="panel-block">
        <h2>Recent signals</h2>
        ${
          recentSignals.length
            ? recentSignals
                .map(
                  (sg) => `<div class="mini-row why" style="cursor:pointer" onclick="location.hash='#/token/${sg.token}'">
                    <span class="why-line" style="margin:0"><span class="why-dot sev-${sg.severity}"></span><b>${sg.symbol ? "$" + esc(sg.symbol) : fmtAddr(sg.token)}</b> — ${esc(sg.explanation)}</span>
                  </div>`
                )
                .join("")
            : stateBlock("pending", "NOT ENOUGH HISTORY YET", "No signals recorded yet — see the Signals tab.")
        }
      </div>
      <div class="panel-block">
        <h2>Smart Money</h2>
        ${stateBlock("unavailable", "NOT AVAILABLE", "Requires a cross-token wallet-performance history store or indexer, neither of which is wired up yet. See docs/DATA.md.")}
      </div>
      <div class="panel-block">
        <h2>Social</h2>
        ${stateBlock("unavailable", "NOT AVAILABLE", "Requires a social data source. No reliable one for Robinhood Chain tokens was found. See docs/DATA.md.")}
      </div>
    `;
  } catch (e) {
    document.getElementById("overview-body").innerHTML = stateBlock("error", "COULDN'T LOAD OVERVIEW", e.message);
  }
}

async function renderWalletsView() {
  renderNav("wallets");
  app.innerHTML = `
    <div class="section-head">
      <div><h1>Wallets</h1><p>Net accumulators across the most recently launched tokens. Scoped per-token — see note on each row; there is no cross-token wallet history yet.</p></div>
    </div>
    <div id="wallets-body">${loadingLine()}</div>
  `;
  const body = document.getElementById("wallets-body");
  try {
    const feed = await getJSON("/api/tokens");
    const top = (feed.tokens || []).slice(0, 5);
    const perToken = await Promise.all(
      top.map(async (t) => {
        const w = await getJSON(`/api/tokens/${t.token}/wallets`).catch(() => ({ wallets: [] }));
        return { token: t, wallets: (w.wallets || []).slice(0, 5) };
      })
    );
    const anyWallets = perToken.some((p) => p.wallets.length > 0);
    if (!anyWallets) {
      body.innerHTML = stateBlock("empty", "NO WALLET ACTIVITY", "No wallet activity found across the current feed window.");
      return;
    }
    body.outerHTML = `<div id="wallets-body">${perToken
      .filter((p) => p.wallets.length > 0)
      .map(
        (p) => `
        <div class="panel-block">
          <h2>${p.token.symbol ? "$" + esc(p.token.symbol) : fmtAddr(p.token.token)}</h2>
          <table class="feed">
            <thead><tr><th>Wallet</th><th>Net accumulation</th><th>Scope</th></tr></thead>
            <tbody>
              ${p.wallets
                .map(
                  (w) => `<tr>
                    <td class="addr">${fmtAddr(w.wallet)}</td>
                    <td>${w.tokensTraded ?? "—"}</td>
                    <td style="color:var(--ink-faint);font-size:12px">${w.note || ""}</td>
                  </tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>`
      )
      .join("")}</div>`;
  } catch (e) {
    body.innerHTML = stateBlock("error", "COULDN'T LOAD WALLET ACTIVITY", e.message);
  }
}

async function renderRiskView() {
  renderNav("risk");
  app.innerHTML = `
    <div class="section-head">
      <div><h1>Risk</h1><p>Every token in the current feed window, sorted by risk level — each finding has stated evidence, never a bare "SCAM" label.</p></div>
    </div>
    <div id="risk-body">${loadingLine()}</div>
  `;
  const body = document.getElementById("risk-body");
  const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  try {
    const feed = await getJSON("/api/tokens");
    const tokens = [...(feed.tokens || [])].sort((a, b) => (order[a.riskLevel] ?? 9) - (order[b.riskLevel] ?? 9));
    if (!tokens.length) {
      body.innerHTML = stateBlock("empty", "NOTHING IN THIS WINDOW", "No launches in the current scan window.");
      return;
    }
    body.outerHTML = `
      <table class="feed" id="risk-body">
        <thead><tr><th>Token</th><th>Deployer</th><th>Risk</th><th>FLETCH Score</th></tr></thead>
        <tbody>
          ${tokens
            .map(
              (t) => `<tr onclick="location.hash='#/token/${t.token}'">
                <td><span class="sym">${t.symbol ? "$" + esc(t.symbol) : "unresolved"}</span><br/><span class="addr">${fmtAddr(t.token)}</span>${whyLine(t.topSignal)}</td>
                <td class="addr">${fmtAddr(t.deployer)}</td>
                <td>${severityChip(t.riskLevel)}</td>
                <td>${scoreBadge(t.fletchScore)}</td>
              </tr>`
            )
            .join("")}
        </tbody>
      </table>`;
  } catch (e) {
    body.innerHTML = stateBlock("error", "COULDN'T LOAD RISK DATA", e.message);
  }
}

async function renderMonitoring() {
  renderNav("monitoring");
  app.innerHTML = `
    <div class="section-head">
      <div><h1>Monitoring</h1><p>Is FLETCH actually watching the chain right now? Real counts from the monitoring queue — not a sample, not an estimate.</p></div>
    </div>
    <div id="monitoring-body">${loadingLine()}</div>
  `;
  const body = document.getElementById("monitoring-body");
  try {
    const m = await getJSON("/api/monitoring");
    const statusLabel = m.running ? "WATCHING" : "NOT WATCHING";
    const statusClass = m.running ? "sev-LOW" : "sev-HIGH";
    const statusReason = m.running
      ? null
      : !m.enabled
      ? "ENABLE_POLLER is off"
      : !m.rpcConfigured
      ? "RPC_URL isn't set — nothing to watch with"
      : null;

    body.innerHTML = `
      <div class="panel-block">
        <div class="mini-row"><span><span class="why-dot ${statusClass}" style="margin-right:8px"></span>Watcher status</span><span>${statusLabel}${statusReason ? ` <span style="color:var(--ink-faint);font-weight:400">(${statusReason})</span>` : ""}</span></div>
        <div class="mini-row"><span>Discovery interval</span><span>${Math.round(m.discoveryIntervalMs / 1000)}s</span></div>
        <div class="mini-row"><span>Check interval</span><span>${Math.round(m.pollIntervalMs / 1000)}s</span></div>
        <div class="mini-row"><span>Max concurrent checks</span><span>${m.maxConcurrentTokens}</span></div>
        <div class="mini-row"><span>Max monitored tokens</span><span>${m.maxMonitoredTokens}</span></div>
      </div>

      <div class="grid">
        <div class="card"><div class="k">Monitored</div><div class="v">${m.totalMonitored}</div><div class="sub">${m.activeCount} active</div></div>
        <div class="card"><div class="k">Due right now</div><div class="v">${m.dueNowCount}</div><div class="sub">queue backlog</div></div>
        <div class="card"><div class="k">Failed</div><div class="v">${m.failedCount}</div><div class="sub">gave up after repeated errors</div></div>
      </div>

      <div class="panel-block">
        <h2>Last hour</h2>
        <div class="mini-row"><span>Snapshots collected</span><span>${m.snapshotsLastHour}</span></div>
        <div class="mini-row"><span>Signals generated</span><span>${m.signalsLastHour}</span></div>
        <div class="mini-row"><span>Last successful check</span><span>${m.lastSuccessfulCheckAt ? fmtTime(m.lastSuccessfulCheckAt) : "—"}</span></div>
        <div class="mini-row"><span>Next scheduled check</span><span>${m.nextScheduledCheckAt ? fmtTime(m.nextScheduledCheckAt) : "—"}</span></div>
      </div>

      ${
        m.totalMonitored === 0
          ? stateBlock(
              "pending",
              "NOTHING MONITORED YET",
              "The queue fills in as launches are discovered — set RPC_URL and ENABLE_POLLER=true, or open a token page to check one manually. See docs/MONITORING.md."
            )
          : ""
      }
    `;
  } catch (e) {
    body.innerHTML = stateBlock("error", "COULDN'T LOAD MONITORING STATUS", e.message);
  }
}

function renderDocs() {
  renderNav("docs");
  const docs = [
    { file: "ARCHITECTURE.md", desc: "System design and the data-provider abstraction." },
    { file: "SCORING.md", desc: "Exactly how the FLETCH Score is computed, component by component." },
    { file: "SIGNALS.md", desc: "What counts as a signal, severity and confidence rules." },
    { file: "RADAR.md", desc: "The Radar formula — every constant spelled out." },
    { file: "RISK.md", desc: "Every risk finding, its threshold, and its evidence." },
    { file: "MONITORING.md", desc: "How continuous discovery and monitoring actually work." },
    { file: "DATA.md", desc: "Where every metric comes from — and what's still unavailable." },
    { file: "DEVELOPMENT.md", desc: "Setup, environment variables, and the test suite." },
  ];
  app.innerHTML = `
    <div class="section-head">
      <div><h1>Docs</h1><p>Documentation lives in the repository, not behind an API — these open on GitHub.</p></div>
    </div>
    <div class="docs-grid">
      ${docs
        .map(
          (d) => `<a class="doc-card" href="https://github.com/leopardracer/FLETCH/blob/main/docs/${d.file}" target="_blank" rel="noopener">
            <div class="doc-card-name">${d.file}</div>
            <div class="doc-card-desc">${d.desc}</div>
          </a>`
        )
        .join("")}
    </div>
  `;
}

async function renderFeed() {
  renderNav("tokens");
  app.innerHTML = `
    <div class="section-head">
      <div>
        <h1>Tokens</h1>
        <p>New Pons V2 launches on Robinhood Chain, ranked by FLETCH Score — not market cap. For the live event stream, see the Signals tab.</p>
      </div>
    </div>
    <div id="brief-slot"></div>
    <div id="feed-body">${loadingLine()}</div>
  `;
  loadMarketBrief("brief-slot");
  const body = document.getElementById("feed-body");
  try {
    const data = await getJSON("/api/tokens");
    if (!data.tokens || data.tokens.length === 0) {
      body.innerHTML = stateBlock("empty", "NOTHING IN THIS WINDOW", "No launches found in the scanned window. Widen the window or check back after more chain activity.");
      return;
    }
    learnSymbols(data.tokens);
    const rows = data.tokens
      .map(
        (t) => `
      <tr onclick="location.hash='#/token/${t.token}'">
        <td><span class="sym">${t.symbol ? "$" + esc(t.symbol) : "unresolved"}</span> <span class="addr">${fmtAddr(t.token)}</span>${whyLine(t.topSignal)}</td>
        <td class="num-cell">${fmtAge(t.launchedAt)}</td>
        <td class="num-cell">${fmtUsd(t.liquidityUsd)}</td>
        <td class="num-cell">${t.holderCount ?? "—"}</td>
        <td class="num-cell">${t.devBuyPercent !== null && t.devBuyPercent !== undefined ? t.devBuyPercent.toFixed(1) + "%" : "—"}</td>
        <td>${severityChip(t.riskLevel)}</td>
        <td>${scoreBadge(t.fletchScore)}</td>
      </tr>`
      )
      .join("");
    body.outerHTML = `
      <div class="table-wrap" id="feed-body">
      <table class="feed">
        <thead>
          <tr><th>Token</th><th>Age</th><th>Liquidity</th><th>Holders</th><th>Dev buy</th><th>Risk</th><th>FLETCH Score</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  } catch (e) {
    body.innerHTML = stateBlock("error", "COULDN'T LOAD THE FEED", `${e.message} — is the API running and RPC_URL configured?`);
  }
}

function componentBlock(name, comp) {
  if (comp.value === null) {
    return `<div class="component na">
      <div class="name">${name}</div>
      <div class="val na">N/A</div>
      <div class="sub">${comp.reason}</div>
    </div>`;
  }
  return `<div class="component">
    <div class="name">${name}</div>
    <div class="val">${comp.value}</div>
    <div class="component-bar-track"><div class="component-bar-fill" style="width:${comp.value}%"></div></div>
    <div class="sub">${comp.label}</div>
  </div>`;
}

/** Fills the token page's AI analyst card from the report the page just loaded (no second chain read). */
async function loadTokenAiSummary(address, facts) {
  try {
    const r = await getJSON(`/api/tokens/${address}/ai-summary`);
    const el = document.getElementById("token-ai-slot");
    if (el) el.innerHTML = aiCard("FLETCH AI analyst", r.naturalLanguageSummary, { facts });
  } catch {
    const el = document.getElementById("token-ai-slot");
    if (el) el.innerHTML = "";
  }
}

async function renderToken(address) {
  renderNav(null);
  app.innerHTML = `<a class="back" onclick="location.hash='#/'">&larr; back to feed</a>${loadingLine(fmtAddr(address))}`;
  try {
    const [d, walletsRes, historyRes, signalsRes] = await Promise.all([
      getJSON(`/api/tokens/${address}`),
      getJSON(`/api/tokens/${address}/wallets`).catch(() => ({ wallets: [] })),
      getJSON(`/api/tokens/${address}/history`).catch(() => ({ snapshots: [] })),
      getJSON(`/api/tokens/${address}/signals`).catch(() => ({ signals: [], lifecycle: [] })),
    ]);
    const m = d.metrics;
    const s = d.fletchScore;
    const wallets = (walletsRes.wallets || []).slice(0, 10);
    const history = (historyRes.snapshots || []).slice(0, 20);
    const signals = (signalsRes.signals || []).slice(0, 25);
    const avail = d.dataAvailability || {};

    app.innerHTML = `
      <a class="back" onclick="location.hash='#/'">&larr; back to feed</a>
      <div class="detail-head">
        <div>
          <h1>${d.token.symbol ? "$" + esc(d.token.symbol) : "Unresolved token"}</h1>
          <div class="addr"><a class="hash" href="${EXPLORER}/token/${esc(d.token.address)}" target="_blank" rel="noopener">${esc(d.token.address)} ↗</a>${d.source === "cache" ? ` <span class="asof">${d.stale ? "stale · " : ""}updated ${fmtAge(d.asOf)} ago</span>` : ""}</div>
        </div>
        <div class="score-big">
          <div class="num">${s.overall !== null ? s.overall : "—"}</div>
          <div class="label">${s.overall !== null ? "FLETCH Score" : (s.overallUnavailableReason || "score unavailable")}</div>
          <div class="risk-under">Risk ${severityChip(d.risk.level)}</div>
        </div>
      </div>

      <div id="token-ai-slot">${aiCardLoading("FLETCH AI analyst")}</div>

      <div class="grid">
        <div class="card">
          <div class="k">Liquidity</div>
          ${m.liquidityUsd !== null
            ? `<div class="v">$${m.liquidityUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>`
            : `<div class="v unavailable">unavailable — ${m.liquidityUsdUnavailableReason || "no data"}</div>`}
        </div>
        <div class="card">
          <div class="k">Holders</div>
          ${m.holderCount !== null
            ? `<div class="v">${m.holderCount}</div><div class="sub">${m.holderCountIsLifetime ? "lifetime" : "scan window"}</div>`
            : `<div class="v unavailable">unavailable</div>`}
        </div>
        <div class="card">
          <div class="k">Buy / Sell (window)</div>
          <div class="v">${m.buyCountWindow} / ${m.sellCountWindow}</div>
        </div>
      </div>

      <div class="panel-block">
        <h2>FLETCH Score components</h2>
        <div class="components">
          ${componentBlock("Momentum", s.components.momentum)}
          ${componentBlock("Smart Money", s.components.smartMoney)}
          ${componentBlock("Social", s.components.social)}
          ${componentBlock("Liquidity", s.components.liquidity)}
          ${componentBlock("Holder Growth", s.components.holderGrowth)}
          ${componentBlock("Whale Activity", s.components.whaleActivity)}
          ${componentBlock("Safety", s.components.safety)}
        </div>
      </div>

      <div class="panel-block">
        <h2>Data availability</h2>
        <div class="avail-chips">
          ${Object.entries(avail).map(([k, v]) => `<span class="avail-chip ${v === "REAL" ? "on" : ""}" title="${esc(v)}">${v === "REAL" ? "●" : "○"} ${esc(k.replace(/([A-Z])/g, " $1").trim().toLowerCase())}</span>`).join("")}
        </div>
      </div>

      <div class="panel-block">
        <h2>Why is it moving?</h2>
        <ul class="fact-list">${d.whyIsItMoving.bullets.map(factItem).join("") || "<li>Not enough data yet.</li>"}</ul>
      </div>

      <div class="panel-block">
        <h2>Risk — ${d.risk.level}</h2>
        <ul class="fact-list">${d.whyIsItMoving.risks.map(factItem).join("")}</ul>
      </div>

      <div class="panel-block">
        <h2>Signal timeline</h2>
        ${(signalsRes.lifecycle || []).length
          ? `<div class="lifecycle-row">${signalsRes.lifecycle
              .filter((l) => l.stage !== "RESOLVED")
              .map((l) => `<span class="lifecycle-item"><span class="signal-type-label">${esc(l.type)}</span>${lifecycleChip(l)}</span>`)
              .join("")}</div>`
          : ""}
        ${
          signals.length
            ? `<div>${signals
                .map(
                  (sig) => `<div class="signal-row" style="cursor:default">
                    <div class="signal-time">${fmtTime(sig.timestamp)}</div>
                    <div class="signal-type">${severityChip(sig.severity)} <span class="signal-type-label">${sig.type.replace(/_/g, " ")}</span></div>
                    <div class="signal-evidence">${richText(sig.evidence).html}</div>
                  </div>`
                )
                .join("")}</div>`
            : stateBlock("pending", "NOT ENOUGH HISTORY YET", "Signals accumulate as this page is viewed or the background poller runs.")
        }
      </div>

      <div class="panel-block">
        <h2>Score history</h2>
        ${
          history.length > 1
            ? `<table class="feed">
                <thead><tr><th>Time</th><th>FLETCH Score</th><th>Holders</th><th>Liquidity</th></tr></thead>
                <tbody>
                  ${history
                    .map(
                      (h) => `<tr style="cursor:default">
                        <td class="addr">${fmtTime(h.takenAt)}</td>
                        <td>${h.fletchScore ?? "—"}</td>
                        <td>${h.holderCount ?? "—"}</td>
                        <td>${h.liquidityUsd !== null && h.liquidityUsd !== undefined ? "$" + h.liquidityUsd.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—"}</td>
                      </tr>`
                    )
                    .join("")}
                </tbody>
              </table>`
            : stateBlock("pending", "NOT ENOUGH HISTORY YET", "Score history builds up as this token is checked over time (page views or the background poller).")
        }
      </div>

      <div class="panel-block">
        <h2>Smart Money</h2>
        ${stateBlock("unavailable", "NOT AVAILABLE", d.smartMoney.reason)}
      </div>

      <div class="panel-block">
        <h2>Social</h2>
        ${stateBlock("unavailable", "NOT AVAILABLE", d.social.reason)}
      </div>

      <div class="panel-block">
        <h2>Wallet activity</h2>
        ${
          wallets.length
            ? `<table class="feed">
                <thead><tr><th>Wallet</th><th>Net accumulation</th><th>Scope</th></tr></thead>
                <tbody>
                  ${wallets
                    .map(
                      (w) => `<tr onclick="location.hash='#/wallet/${w.wallet}'">
                        <td class="addr">${fmtAddr(w.wallet)}</td>
                        <td>${w.tokensTraded ?? "—"}</td>
                        <td style="color:var(--ink-faint);font-size:12px">${w.note || ""}</td>
                      </tr>`
                    )
                    .join("")}
                </tbody>
              </table>`
            : stateBlock("empty", "NO WALLET ACTIVITY", "No holders found in the current scan window.")
        }
      </div>
    `;
    loadTokenAiSummary(address, [...d.whyIsItMoving.bullets, ...d.whyIsItMoving.risks]);
  } catch (e) {
    const notFound = e.status === 404;
    app.innerHTML = `
      <a class="back" onclick="location.hash='#/'">&larr; back to feed</a>
      ${stateBlock(notFound ? "unavailable" : "error", notFound ? "TOKEN NOT FOUND" : "COULDN'T LOAD THIS TOKEN", e.message)}`;
  }
}

const CHAT_KEY_STORAGE = "fletch_byok_anthropic_key";
let chatMessages = []; // kept at module scope so it survives navigating away and back within this tab
let serverAi = null; // { enabled, model } from GET /api/ai — fetched once

async function getServerAi() {
  if (serverAi) return serverAi;
  try {
    serverAi = await getJSON("/api/ai");
  } catch {
    serverAi = { enabled: false, model: null };
  }
  return serverAi;
}

const CHAT_SUGGESTIONS = [
  "What's moving on Robinhood Chain right now?",
  "Any whale buys in the last hour?",
  "Any liquidity pulls or other red flags?",
  "Is FLETCH watching the chain right now?",
];

function chatBubble(role, text) {
  // Escaped (line breaks are kept by .chat-bubble's pre-wrap): the reply is
  // model text and may quote deployer-controlled token names — never trusted as HTML.
  return `<div class="chat-msg chat-${role}"><div class="chat-bubble">${esc(text)}</div></div>`;
}

function chatToolCallsLine(toolCalls) {
  if (!toolCalls || toolCalls.length === 0) return "";
  const names = toolCalls.map((t) => esc(t.name)).join(", ");
  return `<div class="chat-toolcalls">FLETCH looked up: ${names}</div>`;
}

function renderChatLog() {
  const log = document.getElementById("chat-log");
  if (!log) return;
  if (chatMessages.length === 0) {
    log.innerHTML = `<div class="chat-empty">
      <p>Ask FLETCH AI about Robinhood Chain: a token or wallet address, or what's happening right now. Every answer comes from FLETCH's own on-chain data; it never predicts prices or tells you what to buy.</p>
      <div class="chat-suggestions">${CHAT_SUGGESTIONS.map((q, i) => `<button class="chat-suggestion" data-i="${i}">${esc(q)}</button>`).join("")}</div>
    </div>`;
    log.querySelectorAll(".chat-suggestion").forEach((btn) =>
      btn.addEventListener("click", () => {
        document.getElementById("chat-input").value = CHAT_SUGGESTIONS[Number(btn.dataset.i)];
        sendChatMessage();
      })
    );
    return;
  }
  log.innerHTML = chatMessages
    .map((m) => {
      if (m.role === "user") return chatBubble("user", typeof m.content === "string" ? m.content : "");
      // assistant messages we render are plain strings; tool_use/tool_result turns aren't shown as bubbles
      if (typeof m.content === "string") return chatBubble("assistant", m.content);
      return "";
    })
    .join("");
  log.scrollTop = log.scrollHeight;
}

/** Last ≤20 non-empty turns, starting on a user turn — the shape POST /api/chat accepts. */
function trimForServer(messages) {
  const clean = messages.filter((m) => typeof m.content === "string" && m.content.trim()).slice(-20);
  while (clean.length && clean[0].role !== "user") clean.shift();
  return clean;
}

/** Server mode: FLETCH's own key, same tools, same rules (POST /api/chat). */
async function runServerChat(messages) {
  const res = await fetch(API_BASE + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: trimForServer(messages) }),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // fall through
  }
  if (!res.ok) return { reply: (body && body.error) || `FLETCH AI is unavailable right now (HTTP ${res.status}).`, toolCalls: [] };
  return body;
}

async function sendChatMessage() {
  const input = document.getElementById("chat-input");
  const sendBtn = document.getElementById("chat-send");
  const text = input.value.trim();
  if (!text) return;
  const ai = await getServerAi();
  const apiKey = sessionStorage.getItem(CHAT_KEY_STORAGE) || "";

  chatMessages.push({ role: "user", content: text.slice(0, 4000) });
  input.value = "";
  renderChatLog();

  const log = document.getElementById("chat-log");
  log.insertAdjacentHTML("beforeend", `<div class="chat-msg chat-assistant" id="chat-pending">${loadingLine("FLETCH AI is reading the chain")}</div>`);
  log.scrollTop = log.scrollHeight;
  sendBtn.disabled = true;

  try {
    // The visitor's own key wins if they saved one; otherwise the server's.
    const result = apiKey || !ai.enabled
      ? await window.FletchChatAgent.runBrowserChatAgent(chatMessages, apiKey)
      : await runServerChat(chatMessages);
    chatMessages.push({ role: "assistant", content: result.reply });
    renderChatLog();
    if (result.toolCalls && result.toolCalls.length) {
      document.getElementById("chat-log").insertAdjacentHTML("beforeend", chatToolCallsLine(result.toolCalls));
    }
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

function saveChatKey() {
  const input = document.getElementById("chat-api-key");
  const status = document.getElementById("chat-key-status");
  const key = input.value.trim();
  if (!key) {
    sessionStorage.removeItem(CHAT_KEY_STORAGE);
    status.textContent = "";
    return;
  }
  sessionStorage.setItem(CHAT_KEY_STORAGE, key);
  input.value = "";
  input.placeholder = "•••• saved for this tab";
  status.textContent = "Key saved for this browser tab only — cleared when you close it. Never sent to FLETCH's server.";
}

async function renderChat() {
  renderNav("chat");
  const ai = await getServerAi();
  const hasKey = !!sessionStorage.getItem(CHAT_KEY_STORAGE);
  const keyPanel = `
      <h2>${ai.enabled ? "Use your own Anthropic key instead (optional)" : "Your Anthropic API key"}</h2>
      <p style="color:var(--ink-faint);font-size:12.5px;margin:0 0 10px">
        Calls go straight from this browser tab to api.anthropic.com. Your key is visible in this tab's network requests (devtools) — only paste a key you're fine placing in a browser session.
        Get one at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>.
      </p>
      <div class="chat-key-row">
        <input type="password" id="chat-api-key" placeholder="${hasKey ? "•••• saved for this tab" : "sk-ant-..."}" autocomplete="off" spellcheck="false" />
        <button id="chat-key-save">Save for this tab</button>
      </div>
      <div id="chat-key-status" class="chat-key-status">${hasKey ? "Key saved for this browser tab only — cleared when you close it. Never sent to FLETCH's server." : ""}</div>`;
  app.innerHTML = `
    <div class="section-head">
      <div><h1>Ask FLETCH AI</h1><p>${
        ai.enabled
          ? "Your on-chain analyst for Robinhood Chain. It answers only from what FLETCH itself reads off the chain, and says so plainly when it doesn't know."
          : "Your on-chain analyst for Robinhood Chain. This instance has no server-side AI key, so chat runs in your browser with your own Anthropic key — FLETCH's server never sees it."
      } See <a href="https://github.com/leopardracer/FLETCH/blob/main/docs/AI.md" target="_blank" rel="noopener">docs/AI.md</a>.</p></div>
    </div>

    <div class="panel-block chat-panel">
      <div id="chat-log" class="chat-log"></div>
      <div class="chat-input-row">
        <textarea id="chat-input" placeholder="Paste a token or wallet address, or ask what's happening…" rows="2"></textarea>
        <button id="chat-send">Ask</button>
      </div>
    </div>

    ${ai.enabled ? `<details class="panel-block chat-byok">${keyPanel.replace("<h2>", "<summary>").replace("</h2>", "</summary>")}</details>` : `<div class="panel-block">${keyPanel}</div>`}
  `;

  renderChatLog();
  document.getElementById("chat-key-save").addEventListener("click", saveChatKey);
  document.getElementById("chat-send").addEventListener("click", sendChatMessage);
  document.getElementById("chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });
}

/** "Ask FLETCH AI" — reachable from every page, not only from the nav. */
function renderAskFab(route) {
  let fab = document.getElementById("ask-fab");
  if (!fab) {
    fab = document.createElement("button");
    fab.id = "ask-fab";
    fab.className = "ask-fab";
    fab.innerHTML = `<img src="mascot.png" alt="" /><span>Ask FLETCH AI</span>`;
    fab.addEventListener("click", () => (location.hash = "#/chat"));
    document.body.appendChild(fab);
  }
  fab.hidden = route === "#/chat";
}

function fmtEth(v) {
  if (typeof v !== "number") return "—";
  const r = Number(v.toFixed(4));
  return `${r > 0 ? "+" : ""}${r} ETH`;
}

function walletMetricValue(v) {
  if (v.availability !== "REAL" || typeof v.value !== "number") return availabilityBadge(v.availability);
  if (v.unit === "ETH") return `<span class="${v.value >= 0 ? "pos" : "neg"}">${fmtEth(v.value)}</span>`;
  if (v.unit === "percent") return `${Number(v.value.toFixed(1))}%`;
  return `${Number(v.value.toFixed(1))} <span style="color:var(--ink-faint)">${esc(v.unit || "")}</span>`;
}

async function renderWalletDetail(address) {
  renderNav(null);
  app.innerHTML = `<a class="back" onclick="history.back()">&larr; back</a>${loadingLine(fmtAddr(address))}`;
  try {
    // ?summary=ai costs no chain reads — wallet data is all persisted — so
    // the AI read loads with the page instead of after it.
    const w = await getJSON(`/api/wallets/${address}?summary=ai`);
    const metricRows = Object.entries(w.metrics)
      .map(
        ([k, v]) => `<div class="avail-row" title="${esc(v.reason || "")}"><span>${k.replace(/([A-Z])/g, " $1").trim()}</span><span>${walletMetricValue(v)}</span></div>`
      )
      .join("");
    const positions = w.positions || [];
    app.innerHTML = `
      <a class="back" onclick="history.back()">&larr; back</a>
      <div class="detail-head">
        <div>
          <h1>Wallet</h1>
          <div class="addr">${esc(w.wallet)}</div>
        </div>
      </div>
      ${aiCard("FLETCH AI wallet read", w.naturalLanguageSummary, { facts: w.aiFacts })}
      <div class="panel-block">
        <h2>Performance</h2>
        <p style="color:var(--ink-faint);font-size:12.5px;margin-top:0">From every curve trade FLETCH recorded with its exact price, only over history it saw from each token's launch. Anything it can't back with real trades says so.</p>
        <div class="avail-grid">${metricRows}</div>
      </div>
      <div class="panel-block">
        <h2>Positions</h2>
        ${
          positions.length
            ? `<table class="feed">
                <thead><tr><th>Token</th><th>Status</th><th>Trades</th><th>Realized</th></tr></thead>
                <tbody>${positions
                  .map(
                    (p) => `<tr onclick="location.hash='#/token/${esc(p.token)}'">
                      <td class="addr">${fmtAddr(p.token)}</td>
                      <td>${p.status === "UNKNOWN_COST_BASIS" ? `<span class="chip na" title="Sold tokens FLETCH never saw it buy">UNKNOWN COST</span>` : `<span class="chip ${p.status === "OPEN" ? "MEDIUM" : "LOW"}">${p.status}</span>`}</td>
                      <td>${p.tradesCounted}</td>
                      <td>${p.realizedPnlPair === null ? "—" : fmtEth(p.realizedPnlPair)}</td>
                    </tr>`
                  )
                  .join("")}</tbody>
              </table>`
            : stateBlock("pending", "NO POSITIONS YET", "No curve trades recorded for this wallet inside a token's gap-free history from launch.")
        }
      </div>
      <div class="panel-block">
        <h2>Linked wallets</h2>
        <p style="color:var(--ink-faint);font-size:12.5px;margin-top:0">Wallets whose first buy landed within 2 blocks of this wallet's on at least 2 of the same tokens. A coordinated-entry timing pattern — not proof of common ownership.</p>
        ${
          (w.linkedWallets || []).length
            ? `<table class="feed">
                <thead><tr><th>Wallet</th><th>Shared tokens</th><th>Max gap</th></tr></thead>
                <tbody>${w.linkedWallets
                  .map(
                    (l) => `<tr onclick="location.hash='#/wallet/${esc(l.wallet)}'">
                      <td class="addr">${fmtAddr(l.wallet)}</td>
                      <td>${l.sharedTokens}</td>
                      <td>${l.maxBlockGap} block${l.maxBlockGap === 1 ? "" : "s"}</td>
                    </tr>`
                  )
                  .join("")}</tbody>
              </table>`
            : stateBlock("empty", "NO COORDINATED ENTRIES FOUND", "No other wallet repeatedly entered the same tokens within 2 blocks of this one.")
        }
      </div>
      <div class="panel-block">
        <h2>Recorded activity</h2>
        ${
          w.profile
            ? `<div class="mini-row"><span>Tokens touched</span><span>${w.profile.tokensTouched.length}</span></div>
               <div class="mini-row"><span>First seen</span><span>${fmtTime(w.profile.firstSeenAt)}</span></div>
               <div class="mini-row"><span>Last seen</span><span>${fmtTime(w.profile.lastSeenAt)}</span></div>
               <div class="mini-row"><span>Records</span><span>${w.profile.totalRecords}</span></div>`
            : stateBlock("pending", "NOT ENOUGH HISTORY YET", "No recorded activity for this wallet yet.")
        }
      </div>
    `;
  } catch (e) {
    app.innerHTML = `<a class="back" onclick="history.back()">&larr; back</a>${stateBlock("error", "COULDN'T LOAD THIS WALLET", esc(e.message))}`;
  }
}

function route() {
  const hash = location.hash || "#/";
  renderAskFab(hash);
  const tokenMatch = hash.match(/^#\/token\/(0x[a-fA-F0-9]{40})$/);
  const walletMatch = hash.match(/^#\/wallet\/(0x[a-fA-F0-9]{40})$/);
  if (tokenMatch) {
    renderToken(tokenMatch[1]);
  } else if (walletMatch) {
    renderWalletDetail(walletMatch[1]);
  } else if (hash === "#/overview") {
    renderOverview();
  } else if (hash === "#/radar") {
    renderRadar();
  } else if (hash === "#/live-signals") {
    renderLiveSignals();
  } else if (hash === "#/wallets") {
    renderWalletsView();
  } else if (hash === "#/risk") {
    renderRiskView();
  } else if (hash === "#/chat") {
    renderChat();
  } else if (hash === "#/monitoring") {
    renderMonitoring();
  } else if (hash === "#/docs") {
    renderDocs();
  } else {
    renderFeed();
  }
}

window.addEventListener("hashchange", route);
checkHealth();
setInterval(checkHealth, 20000); // live block number — the header cat hops on each new one
initMascot();
route();


/* ================= the FLETCH cat =================
 * Small, deliberate motion — the cat reacts to real things (a new block, a
 * CRITICAL finding, an empty list) rather than animating for its own sake.
 * Everything respects prefers-reduced-motion (see styles.css).
 */
let lastBlockSeen = null;
const CAT_LINES = [
  "reading the chain…",
  "0 guesses made today.",
  "snipers? noted.",
  "every number here is on-chain.",
  "i don't predict. i read.",
  "same block again? suspicious.",
  "nothing here is invented.",
];

function catHop(el) {
  if (!el) return;
  el.classList.remove("hop");
  void el.offsetWidth; // restart the animation
  el.classList.add("hop");
}

function catAlert(el) {
  if (!el) return;
  el.classList.add("alert");
  const wrap = el.parentElement;
  if (wrap && !wrap.querySelector(".cat-bang")) {
    const b = document.createElement("span");
    b.className = "cat-bang";
    b.textContent = "!";
    wrap.insertBefore(b, el.nextSibling);
  }
}

function catSay(text) {
  const brand = document.querySelector(".brand");
  if (!brand) return;
  let bubble = document.getElementById("cat-say");
  if (!bubble) {
    bubble = document.createElement("span");
    bubble.id = "cat-say";
    bubble.className = "cat-say";
    brand.appendChild(bubble);
  }
  bubble.textContent = text;
  bubble.classList.remove("on");
  void bubble.offsetWidth;
  bubble.classList.add("on");
  clearTimeout(catSay._t);
  catSay._t = setTimeout(() => bubble.classList.remove("on"), 2600);
}

function catWalk() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (document.querySelector(".cat-walker")) return;
  const w = document.createElement("div");
  w.className = "cat-walker";
  w.setAttribute("aria-hidden", "true");
  w.innerHTML = `<img src="mascot.png" alt="" />`;
  document.body.appendChild(w);
  w.addEventListener("animationend", () => w.remove());
}

function initMascot() {
  const cat = document.querySelector(".brand-cat");
  if (cat) {
    cat.addEventListener("click", (e) => {
      e.preventDefault();
      catHop(cat);
      catSay(CAT_LINES[Math.floor(Math.random() * CAT_LINES.length)]);
    });
    cat.style.cursor = "pointer";
    cat.title = "pet the cat";
  }
  // Once per visit, a little while in, the cat strolls along the bottom of the page.
  if (!sessionStorage.getItem("fletch-cat-walked")) {
    setTimeout(() => {
      catWalk();
      try { sessionStorage.setItem("fletch-cat-walked", "1"); } catch {}
    }, 9000);
  }
}
