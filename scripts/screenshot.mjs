/**
 * Captures real screenshots of the running FLETCH dashboard into assets/.
 * Requires Playwright, which is NOT a dependency of this project (it's a
 * heavy, one-time dev tool) — install it yourself before running this:
 *
 *   npm install --no-save playwright
 *   npx playwright install chromium
 *   node scripts/screenshot.mjs
 *
 * This script could not be run or verified in the environment FLETCH was
 * originally built in (its sandboxed network egress only allows package
 * registries, not a browser-binary CDN) — so no screenshots ship in
 * assets/ yet. This is the real tool to generate them, not a placeholder;
 * it just needs to be run by someone with normal network access, against
 * a running `npm run dev` (and ideally a real RPC_URL so the feed has
 * live tokens — otherwise the screenshot will show the honest empty state).
 */
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, "../assets");
const base = process.env.FLETCH_URL || "http://localhost:8787";

const shots = [
  { name: "dashboard.png", hash: "#/" },
  { name: "overview.png", hash: "#/overview" },
  { name: "risk.png", hash: "#/risk" },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

for (const shot of shots) {
  await page.goto(base + shot.hash, { waitUntil: "networkidle" });
  await page.waitForTimeout(500); // let the feed fetch settle
  await page.screenshot({ path: path.join(outDir, shot.name) });
  console.log(`wrote assets/${shot.name}`);
}

// Token detail page needs a real token address from the live feed — grab the first one.
try {
  await page.goto(base + "#/", { waitUntil: "networkidle" });
  const firstRow = await page.$("table.feed tbody tr");
  if (firstRow) {
    await firstRow.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, "token-page.png") });
    console.log("wrote assets/token-page.png");
  } else {
    console.log("no tokens in the feed yet — skipped token-page.png (run against a live RPC_URL with recent Pons launches)");
  }
} catch (e) {
  console.warn("token-page.png skipped:", e.message);
}

await browser.close();
