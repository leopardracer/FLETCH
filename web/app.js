const API_BASE = window.FLETCH_API_BASE || ""; // same-origin by default — server.ts serves this file itself
const app = document.getElementById("app");

const NAV = [
  { id: "overview", label: "Overview" },
  { id: "signals", label: "Early Signals" },
  { id: "wallets", label: "Wallets" },
  { id: "risk", label: "Risk" },
  { id: "docs", label: "Docs" },
];

function renderNav(active) {
  const bar = document.getElementById("navbar");
  if (!bar) return;
  bar.innerHTML = NAV.map(
    (n) => `<a class="navlink${n.id === active ? " active" : ""}" onclick="location.hash='#/${n.id === "signals" ? "" : n.id}'">${n.label}</a>`
  ).join("");
}

async function getJSON(path) {
  const res = await fetch(API_BASE + path);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

function fmtAddr(a) {
  if (!a) return "—";
  return a.slice(0, 6) + "…" + a.slice(-4);
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

function riskChip(level) {
  if (!level) return `<span class="chip na">N/A</span>`;
  return `<span class="chip ${level}">${level}</span>`;
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

async function renderOverview() {
  renderNav("overview");
  app.innerHTML = `
    <div class="section-head">
      <div><h1>Overview</h1><p>Everything below comes from the same live feed as Early Signals — filtered differently.</p></div>
    </div>
    <div class="overview-grid" id="overview-body">
      <div class="panel-block"><h2>Moving now</h2><div class="empty">loading…</div></div>
      <div class="panel-block"><h2>Risk alerts</h2><div class="empty">loading…</div></div>
    </div>
  `;
  try {
    const data = await getJSON("/api/tokens");
    const tokens = data.tokens || [];
    const movingNow = [...tokens].sort((a, b) => (b.fletchScore ?? -1) - (a.fletchScore ?? -1)).slice(0, 8);
    const alerts = tokens.filter((t) => t.riskLevel === "HIGH" || t.riskLevel === "CRITICAL").slice(0, 8);

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
            : `<div class="empty">No launches in the current scan window.</div>`
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
                    <span>${riskChip(t.riskLevel)}</span>
                  </div>`
                )
                .join("")
            : `<div class="empty">No elevated risk findings in the current scan window.</div>`
        }
      </div>
      <div class="panel-block">
        <h2>Smart Money</h2>
        <div class="empty">UNAVAILABLE — no cross-token wallet-performance history store or indexer is wired up yet. See docs/DATA.md.</div>
      </div>
      <div class="panel-block">
        <h2>Social</h2>
        <div class="empty">UNAVAILABLE — no reliable social-mentions source for Robinhood Chain tokens was found. See docs/DATA.md.</div>
      </div>
    `;
  } catch (e) {
    document.getElementById("overview-body").innerHTML = `<div class="error">Couldn't load the overview — ${e.message}</div>`;
  }
}

async function renderWalletsView() {
  renderNav("wallets");
  app.innerHTML = `
    <div class="section-head">
      <div><h1>Wallets</h1><p>Net accumulators across the most recently launched tokens. Scoped per-token — see note on each row; there is no cross-token wallet history yet.</p></div>
    </div>
    <div id="wallets-body" class="empty">loading…</div>
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
      body.innerHTML = `<div class="empty">No wallet activity found across the current feed window.</div>`;
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
    body.innerHTML = `<div class="error">Couldn't load wallet activity — ${e.message}</div>`;
  }
}

async function renderRiskView() {
  renderNav("risk");
  app.innerHTML = `
    <div class="section-head">
      <div><h1>Risk</h1><p>Every token in the current feed window, sorted by risk level — each finding has stated evidence, never a bare "SCAM" label.</p></div>
    </div>
    <div id="risk-body" class="empty">loading…</div>
  `;
  const body = document.getElementById("risk-body");
  const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  try {
    const feed = await getJSON("/api/tokens");
    const tokens = [...(feed.tokens || [])].sort((a, b) => (order[a.riskLevel] ?? 9) - (order[b.riskLevel] ?? 9));
    if (!tokens.length) {
      body.innerHTML = `<div class="empty">No launches in the current scan window.</div>`;
      return;
    }
    body.outerHTML = `
      <table class="feed" id="risk-body">
        <thead><tr><th>Token</th><th>Deployer</th><th>Risk</th><th>FLETCH Score</th></tr></thead>
        <tbody>
          ${tokens
            .map(
              (t) => `<tr onclick="location.hash='#/token/${t.token}'">
                <td><span class="sym">${t.symbol ? "$" + t.symbol : "unresolved"}</span><br/><span class="addr">${fmtAddr(t.token)}</span></td>
                <td class="addr">${fmtAddr(t.deployer)}</td>
                <td>${riskChip(t.riskLevel)}</td>
                <td>${scoreBadge(t.fletchScore)}</td>
              </tr>`
            )
            .join("")}
        </tbody>
      </table>`;
  } catch (e) {
    body.innerHTML = `<div class="error">Couldn't load risk data — ${e.message}</div>`;
  }
}

function renderDocs() {
  renderNav("docs");
  app.innerHTML = `
    <div class="section-head">
      <div><h1>Docs</h1><p>Documentation lives in the repository, not behind an API.</p></div>
    </div>
    <div class="panel-block">
      <ul>
        <li><a href="https://github.com/leopardracer/FLETCH/blob/main/docs/ARCHITECTURE.md" target="_blank">ARCHITECTURE.md</a> — system design and the data-provider abstraction</li>
        <li><a href="https://github.com/leopardracer/FLETCH/blob/main/docs/SCORING.md" target="_blank">SCORING.md</a> — exactly how the FLETCH Score is computed</li>
        <li><a href="https://github.com/leopardracer/FLETCH/blob/main/docs/SIGNALS.md" target="_blank">SIGNALS.md</a> — what counts as a signal and why</li>
        <li><a href="https://github.com/leopardracer/FLETCH/blob/main/docs/RISK.md" target="_blank">RISK.md</a> — risk levels and evidence rules</li>
        <li><a href="https://github.com/leopardracer/FLETCH/blob/main/docs/DATA.md" target="_blank">DATA.md</a> — where every metric comes from, and what's still unavailable</li>
        <li><a href="https://github.com/leopardracer/FLETCH/blob/main/docs/DEVELOPMENT.md" target="_blank">DEVELOPMENT.md</a> — running, testing, and extending FLETCH</li>
      </ul>
    </div>
  `;
}

async function renderFeed() {
  renderNav("signals");
  app.innerHTML = `
    <div class="section-head">
      <div>
        <h1>Early Signals</h1>
        <p>New Pons V2 launches on Robinhood Chain, ranked by FLETCH Score — not market cap.</p>
      </div>
    </div>
    <div id="feed-body" class="empty">loading…</div>
  `;
  const body = document.getElementById("feed-body");
  try {
    const data = await getJSON("/api/tokens");
    if (!data.tokens || data.tokens.length === 0) {
      body.innerHTML = `<div class="empty">No launches found in the scanned window. Widen the window or check back after more chain activity.</div>`;
      return;
    }
    const rows = data.tokens
      .map(
        (t) => `
      <tr onclick="location.hash='#/token/${t.token}'">
        <td><span class="sym">${t.symbol ? "$" + t.symbol : "unresolved"}</span><br/><span class="addr">${fmtAddr(t.token)}</span></td>
        <td class="addr">${fmtAddr(t.deployer)}</td>
        <td>${t.devBuyPercent !== null ? t.devBuyPercent.toFixed(1) + "%" : "—"}</td>
        <td>${riskChip(t.riskLevel)}</td>
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
    body.innerHTML = `<div class="error">Couldn't load the feed — ${e.message}. Is the API running and RPC_URL configured?</div>`;
  }
}

function componentBlock(name, comp) {
  if (comp.value === null) {
    return `<div class="component"><div class="name">${name}</div><div class="val na">unavailable — ${comp.reason}</div></div>`;
  }
  return `<div class="component"><div class="name">${name}</div><div class="val">${comp.value}</div><div class="sub">${comp.label}</div></div>`;
}

async function renderToken(address) {
  renderNav(null);
  app.innerHTML = `<a class="back" onclick="location.hash='#/'">&larr; back to feed</a><div class="empty">loading ${fmtAddr(address)}…</div>`;
  try {
    const [d, walletsRes] = await Promise.all([
      getJSON(`/api/tokens/${address}`),
      getJSON(`/api/tokens/${address}/wallets`).catch(() => ({ wallets: [] })),
    ]);
    const m = d.metrics;
    const s = d.fletchScore;
    const wallets = (walletsRes.wallets || []).slice(0, 10);

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
          ${componentBlock("Safety", s.components.safety)}
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
        <h2>Smart Money</h2>
        ${
          d.smartMoney.available
            ? `<div class="empty">Smart-money wallets available — rendering not yet built for this response shape.</div>`
            : `<div class="empty">UNAVAILABLE — ${d.smartMoney.reason}</div>`
        }
      </div>

      <div class="panel-block">
        <h2>Social</h2>
        ${
          d.social.available
            ? `<div class="empty">Social signal available — rendering not yet built for this response shape.</div>`
            : `<div class="empty">UNAVAILABLE — ${d.social.reason}</div>`
        }
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
                      (w) => `<tr>
                        <td class="addr">${fmtAddr(w.wallet)}</td>
                        <td>${w.tokensTraded ?? "—"}</td>
                        <td style="color:var(--ink-faint);font-size:12px">${w.note || ""}</td>
                      </tr>`
                    )
                    .join("")}
                </tbody>
              </table>`
            : `<div class="empty">No wallet activity found for this token yet.</div>`
        }
      </div>
    `;
  } catch (e) {
    app.innerHTML = `<a class="back" onclick="location.hash='#/'">&larr; back to feed</a><div class="error">Couldn't load this token — ${e.message}</div>`;
  }
}

function route() {
  const hash = location.hash || "#/";
  const tokenMatch = hash.match(/^#\/token\/(0x[a-fA-F0-9]{40})$/);
  if (tokenMatch) {
    renderToken(tokenMatch[1]);
  } else if (hash === "#/overview") {
    renderOverview();
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
