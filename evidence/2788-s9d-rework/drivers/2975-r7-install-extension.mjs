// INSTALL AN AGENT EXTENSION THROUGH THE APP'S OWN UPLOAD SCREEN
// (/configuration/extensions/upload).
//
// WHY THIS AND NOT THE MARKETPLACE. The marketplace's own screen says it: browsing
// the catalogue works without setup, but INSTALLING needs the package registry
// connected, and this lane holds no registry credential. The upload screen is the
// product's other install path and needs none, so it is the one a lane can take.
// The app's own install pipeline writes the row; this driver picks the file, picks
// the widest access scope offered and presses Upload, then reads the row back.
//
//   env: WALK_BASE, LANE_ACCOUNT, LANE_SECRET, SUPABASE_DB_URL, UPLOAD_ZIP, INSTALL_PACKAGE
import { chromium } from "@playwright/test";
import pg from "pg";

const BASE = process.env.WALK_BASE;
const ZIP = process.env.UPLOAD_ZIP;
const PKG = process.env.INSTALL_PACKAGE;
for (const [n, v] of Object.entries({ WALK_BASE: BASE, UPLOAD_ZIP: ZIP, INSTALL_PACKAGE: PKG }))
  if (!v) throw new Error(`the upload driver needs ${n}`);
const browser = await chromium.launch();
const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 1100 } });
await ctx.request.post("/api/auth/sign-in/email", {
  headers: { Origin: BASE },
  data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET },
});
const page = await ctx.newPage();
page.setDefaultTimeout(300_000);
await page.goto("/configuration/extensions/upload", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
const scope = page.getByRole("button", { name: /^(Personal: Only me|Organization|Workspace)/ }).first();
if (await scope.count()) {
  await scope.click();
  await page.waitForTimeout(1500);
  const opts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="option"],[role="menuitem"]')).map((o) => o.textContent.replace(/\s+/g, " ").trim()));
  const widest = opts.find((o) => /organization|workspace|everyone|all/i.test(o));
  if (widest) await page.getByRole("option", { name: widest, exact: true }).first().click().catch(() => {});
  else await page.keyboard.press("Escape");
  await page.waitForTimeout(1200);
}
await page.locator('input[type="file"]').first().setInputFiles(ZIP);
await page.waitForTimeout(3000);
await page.getByRole("button", { name: /^Upload/ }).first().click();
await page.waitForTimeout(45_000);
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL });
await c.connect();
const rows = (await c.query(
  `select package_name, owner_level, status from cinatra.installed_extension where package_name = $1`, [PKG])).rows;
await c.end();
console.log(rows.length ? `PASS the app installed ${JSON.stringify(rows[0])}` : "FAIL no install row was written");
process.exitCode = rows.length ? 0 : 1;
await browser.close();
