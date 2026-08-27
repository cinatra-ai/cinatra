// INSTALL THE RUN'S AGENT AND ITS AGENT DEPENDENCY THROUGH THE PRODUCT'S OWN
// MARKETPLACE — the storefront's own "Install now", pressed in a real browser.
// Nothing is written here by hand: the app's own install path does the work and
// the installed rows are read back afterwards.
import { chromium } from "@playwright/test";
import { Client } from "pg";

const BASE = process.env.WALK_BASE;
const DB = process.env.SUPABASE_DB_URL;
const WANTED = (process.env.WALK_INSTALL ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!BASE || !DB || WANTED.length === 0) throw new Error("needs WALK_BASE, SUPABASE_DB_URL, WALK_INSTALL");

const b = await chromium.launch();
const ctx = await b.newContext({ baseURL: BASE, viewport: { width: 1440, height: 1200 } });
const page = await ctx.newPage();
page.setDefaultTimeout(300_000);
page.setDefaultNavigationTimeout(300_000);
await page.request.post("/api/auth/sign-in/email", { headers: { Origin: BASE }, data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET } });

for (const pkg of WANTED) {
  const slug = pkg.replace(/^@[^/]+\//, "");
  await page.goto(`/configuration/marketplace?q=${encodeURIComponent(slug)}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
  // The storefront card that names this package, and the Install now on it.
  let card = page.locator(`[data-package-name="${pkg}"]`);
  if ((await card.count()) === 0) {
    card = page.locator("article, [data-marketplace-card], li, div").filter({ hasText: new RegExp(slug.replace(/-/g, "[- ]"), "i") }).last();
  }
  const install = card.getByRole("button", { name: /^Install now$/ }).first();
  const n = await install.count();
  console.log(`${pkg}: install-now controls found = ${n}`);
  if (n === 0) {
    const already = await card.getByText(/^Installed$/).count();
    console.log(`  ${already > 0 ? "already installed" : "NO INSTALL CONTROL"}`);
    continue;
  }
  await install.scrollIntoViewIfNeeded().catch(() => {});
  await install.click();
  console.log(`  pressed Install now for ${pkg}`);
  for (let i = 0; i < 90; i += 1) {
    await page.waitForTimeout(4000);
    const db = new Client({ connectionString: DB });
    await db.connect();
    const r = await db.query(`select status from cinatra.installed_extension where package_name=$1`, [pkg]);
    await db.end();
    if (r.rowCount > 0) { console.log(`  installed row: status=${r.rows[0].status} after ~${(i + 1) * 4}s`); break; }
    const t = ((await page.locator("body").textContent()) ?? "").replace(/\s+/g, " ");
    const err = t.match(/(error|failed|could not)[^.]{0,140}/i);
    if (err && i > 3) { console.log("  page reports:", err[0].slice(0, 160)); }
  }
}

const db = new Client({ connectionString: DB });
await db.connect();
const rows = (await db.query(
  `select package_name, kind, status, version from cinatra.installed_extension where package_name = ANY($1) order by package_name`, [WANTED])).rows;
console.log("READBACK " + JSON.stringify(rows, null, 1));
await db.end();
await b.close();
