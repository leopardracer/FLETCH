const API_BASE = window.FLETCH_API_BASE || ""; // same-origin by default — server.ts serves this file itself
const app = document.getElementById("app");

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

async function renderFeed() {
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
  app.innerHTML = `<a class="back" onclick="location.hash='#/'">&larr; back to feed</a><div class="empty">loading ${fmtAddr(address)}…</div>`;
  try {
    const d = await getJSON(`/api/tokens/${address}`);
    const m = d.metrics;
    const s = d.fletchScore;

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
  } else {
    renderFeed();
  }
}

window.addEventListener("hashchange", route);
checkHealth();
route();
