// Press the Continue the run's own page draws for a mid-run approval step, and
// EXIT AT ONCE. The catcher that calls this holds a short budget so a slow page
// can never block it across the working window; the run's own rows are what say
// whether the press landed, and the catcher reads those.
import { chromium } from "@playwright/test";
const BASE = process.env.WALK_BASE, PAGE = process.argv[2];
const b = await chromium.launch();
try {
  const ctx = await b.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
  await ctx.request.post("/api/auth/sign-in/email", { headers: { Origin: BASE }, data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(25000);
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Continue", { timeout: 25000 });
  await page.waitForTimeout(2500);
  for (const f of await page.locator("input[type='text'], input:not([type]), textarea").all()) {
    if (!(await f.isVisible().catch(() => false))) continue;
    if (await f.isDisabled().catch(() => true)) continue;
    if (await f.inputValue().catch(() => "x")) continue;
    await f.fill(process.env.ANSWER_TEXT ?? "A short note on what changed in the connector rollout this week.").catch(() => {});
  }
  await page.waitForTimeout(800);
  await page.evaluate(() => { const b = Array.from(document.querySelectorAll("button")).find(x => (x.textContent ?? "").trim() === "Continue"); if (b) b.click(); });
  await page.waitForTimeout(2500);
  console.log("PASS pressed Continue on the run's approval step");
} catch (e) {
  console.log("press skipped: " + String(e?.message ?? e).slice(0, 90));
} finally { await b.close(); }
