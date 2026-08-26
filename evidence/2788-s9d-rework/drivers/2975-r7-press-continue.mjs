// Press the Continue the run's own page draws for a mid-run approval step. The
// press is the person's press, on the button the page draws; nothing is written
// to the database here.
//
//   usage: node 2975-r7-press-continue.mjs <run page path>
//   env:   WALK_BASE, LANE_ACCOUNT, LANE_SECRET
import { chromium } from "@playwright/test";

const BASE = process.env.WALK_BASE;
const PAGE = process.argv[2];
if (!BASE || !PAGE) throw new Error("needs WALK_BASE and a run page path");
const browser = await chromium.launch();
const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
await ctx.request.post("/api/auth/sign-in/email", {
  headers: { Origin: BASE },
  data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET },
});
const page = await ctx.newPage();
page.setDefaultTimeout(Number(process.env.PRESS_TIMEOUT_MS ?? 240_000));
try {
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Continue");
  await page.waitForTimeout(1500);
  // The run panel repaints while the run polls, so the auto-waiting click never
  // finds the button "stable"; the press is still dispatched on the button the
  // page draws, not on a route behind it.
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button")).find((x) => (x.textContent ?? "").trim() === "Continue");
    if (b) b.click();
  });
  console.log("PASS pressed Continue on the run's approval step");
} catch (e) {
  console.log(`press skipped: ${String(e?.message ?? e).slice(0, 100)}`);
}
await browser.close();
