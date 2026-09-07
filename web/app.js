const API_BASE = window.FLETCH_API_BASE || ""; // same-origin by default — server.ts serves this file itself
const app = document.getElementById("app");

const NAV = [
  { id: "overview", label: "Overview" },
  { id: "radar", label: "Radar" },
  { id: "live-signals", label: "Signals" },
  { id: "tokens", label: "Tokens" },
  { id: "wallets", label: "Wallets" },
  { id: "risk", label: "Risk" },
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

function fmtAddr(a) {
  if (!a) return "—";
  return a.slice(0, 6) + "…" + a.slice(-4);
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
  return `<div class="why-line"><span class="why-dot sev-${topSignal.severity}"></span>${topSignal.explanation}</div>`;
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
  return `<div class="state-block state-${kind}"><div class="state-title">${title}</div>${body ? `<div class="state-body">${body}</div>` : ""}</div>`;
}

/** A small terminal-style loading indicator — a blinking cursor, not a spinner or skeleton. */
function loadingLine(label) {
  return `<div class="loading-line">${label || "loading"}<span class="cursor">▌</span></div>`;
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
          <div class="signal-token">${s.symbol ? "$" + s.symbol : fmtAddr(s.token)}</div>
          <div class="signal-type">${severityChip(s.severity)} <span class="signal-type-label">${s.type.replace(/_/g, " ")}</span></div>
          <div class="signal-evidence">${s.evidence}</div>
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
      text.textContent = `chain connected — block ${h.chain.blockNumber}`;
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
          <span class="radar-sym">${e.symbol ? "$" + e.symbol : fmtAddr(e.token)}</span>
          <span class="radar-score-badge"><span class="radar-score-label">RADAR</span><span class="radar-score-num">${e.radarScore}</span></span>
        </div>

        <div class="radar-row">
          <span class="radar-risk-label">RISK</span>${severityChip(e.riskLevel)}
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
    <div class="overview-grid" id="overview-body">
      <div class="panel-block"><h2>Moving now</h2>${loadingLine()}</div>
      <div class="panel-block"><h2>Risk alerts</h2>${loadingLine()}</div>
    </div>
  `;
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
                    <span class="sym">${t.symbol ? "$" + t.symbol : fmtAddr(t.token)}</span>
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
                    <span class="sym">${t.symbol ? "$" + t.symbol : fmtAddr(t.token)}</span>
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
                    <span class="why-line" style="margin:0"><span class="why-dot sev-${sg.severity}"></span><b>${sg.symbol ? "$" + sg.symbol : fmtAddr(sg.token)}</b> — ${sg.explanation}</span>
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
          <h2>${p.token.symbol ? "$" + p.token.symbol : fmtAddr(p.token.token)}</h2>
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
                <td><span class="sym">${t.symbol ? "$" + t.symbol : "unresolved"}</span><br/><span class="addr">${fmtAddr(t.token)}</span>${whyLine(t.topSignal)}</td>
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

function renderDocs() {
  renderNav("docs");
  const docs = [
    { file: "ARCHITECTURE.md", desc: "System design and the data-provider abstraction." },
    { file: "SCORING.md", desc: "Exactly how the FLETCH Score is computed, component by component." },
    { file: "SIGNALS.md", desc: "What counts as a signal, severity and confidence rules." },
    { file: "RISK.md", desc: "Every risk finding, its threshold, and its evidence." },
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
    <div id="feed-body">${loadingLine()}</div>
  `;
  const body = document.getElementById("feed-body");
  try {
    const data = await getJSON("/api/tokens");
    if (!data.tokens || data.tokens.length === 0) {
      body.innerHTML = stateBlock("empty", "NOTHING IN THIS WINDOW", "No launches found in the scanned window. Widen the window or check back after more chain activity.");
      return;
    }
    const rows = data.tokens
      .map(
        (t) => `
      <tr onclick="location.hash='#/token/${t.token}'">
        <td><span class="sym">${t.symbol ? "$" + t.symbol : "unresolved"}</span><br/><span class="addr">${fmtAddr(t.token)}</span>${whyLine(t.topSignal)}</td>
        <td class="addr">${fmtAddr(t.deployer)}</td>
        <td>${t.devBuyPercent !== null ? t.devBuyPercent.toFixed(1) + "%" : "—"}</td>
        <td>${severityChip(t.riskLevel)}</td>
        <td>${scoreBadge(t.fletchScore)}</td>
      </tr>`
      )
      .join("");
    body.outerHTML = `
      <table class="feed" id="feed-body">
        <thead>
          <tr><th>Token</th><th>Deployer</th><th>Dev buy</th><th>Risk</th><th>FLETCH Score</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
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

async function renderToken(address) {
  renderNav(null);
  app.innerHTML = `<a class="back" onclick="location.hash='#/'">&larr; back to feed</a>${loadingLine(fmtAddr(address))}`;
  try {
    const [d, walletsRes, historyRes, signalsRes] = await Promise.all([
      getJSON(`/api/tokens/${address}`),
      getJSON(`/api/tokens/${address}/wallets`).catch(() => ({ wallets: [] })),
      getJSON(`/api/tokens/${address}/history`).catch(() => ({ snapshots: [] })),
      getJSON(`/api/tokens/${address}/signals`).catch(() => ({ signals: [] })),
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
          <h1>${d.token.symbol ? "$" + d.token.symbol : "Unresolved token"}</h1>
          <div class="addr">${d.token.address}</div>
        </div>
        <div class="score-big">
          <div class="num">${s.overall !== null ? s.overall : "—"}</div>
          <div class="label">${s.overall !== null ? "FLETCH Score" : (s.overallUnavailableReason || "score unavailable")}</div>
        </div>
      </div>

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
        <div class="avail-grid">
          ${Object.entries(avail).map(([k, v]) => `<div class="avail-row"><span>${k.replace(/([A-Z])/g, " $1").trim()}</span>${availabilityBadge(v)}</div>`).join("")}
        </div>
      </div>

      <div class="panel-block">
        <h2>Why is it moving?</h2>
        <ul>${d.whyIsItMoving.bullets.map((b) => `<li>${b}</li>`).join("") || "<li>Not enough data yet.</li>"}</ul>
      </div>

      <div class="panel-block">
        <h2>Risk — ${d.risk.level}</h2>
        <ul>${d.whyIsItMoving.risks.map((r) => `<li>${r}</li>`).join("")}</ul>
      </div>

      <div class="panel-block">
        <h2>Signal timeline</h2>
        ${
          signals.length
            ? `<div>${signals
                .map(
                  (sig) => `<div class="signal-row" style="cursor:default">
                    <div class="signal-time">${fmtTime(sig.timestamp)}</div>
                    <div class="signal-type">${severityChip(sig.severity)} <span class="signal-type-label">${sig.type.replace(/_/g, " ")}</span></div>
                    <div class="signal-evidence">${sig.evidence}</div>
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
  } catch (e) {
    const notFound = e.status === 404;
    app.innerHTML = `
      <a class="back" onclick="location.hash='#/'">&larr; back to feed</a>
      ${stateBlock(notFound ? "unavailable" : "error", notFound ? "TOKEN NOT FOUND" : "COULDN'T LOAD THIS TOKEN", e.message)}`;
  }
}

async function renderWalletDetail(address) {
  renderNav(null);
  app.innerHTML = `<a class="back" onclick="history.back()">&larr; back</a>${loadingLine(fmtAddr(address))}`;
  try {
    const w = await getJSON(`/api/wallets/${address}`);
    const metricRows = Object.entries(w.metrics)
      .map(([k, v]) => `<div class="avail-row"><span>${k.replace(/([A-Z])/g, " $1").trim()}</span>${availabilityBadge(v.availability)}</div>`)
      .join("");
    app.innerHTML = `
      <a class="back" onclick="history.back()">&larr; back</a>
      <div class="detail-head">
        <div>
          <h1>Wallet</h1>
          <div class="addr">${w.wallet}</div>
        </div>
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
      <div class="panel-block">
        <h2>Wallet intelligence metrics</h2>
        <p style="color:var(--ink-faint);font-size:12.5px;margin-top:0">No fabricated "wallet score" — each metric below is either real or explicitly not yet implemented, with the exact missing data named.</p>
        <div class="avail-grid">${metricRows}</div>
      </div>
    `;
  } catch (e) {
    app.innerHTML = `<a class="back" onclick="history.back()">&larr; back</a>${stateBlock("error", "COULDN'T LOAD THIS WALLET", e.message)}`;
  }
}

function route() {
  const hash = location.hash || "#/";
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
  } else if (hash === "#/docs") {
    renderDocs();
  } else {
    renderFeed();
  }
}

window.addEventListener("hashchange", route);
checkHealth();
route();
