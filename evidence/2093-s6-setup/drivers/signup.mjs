// Lane s6-2093 — create the proof operator account through the REAL sign-up
// surface (no seeding, no session forgery). Runs in an ISOLATED Chromium
// profile under the lane's own output dir.
import { chromium } from "@playwright/test";
import path from "node:path";

const PORT = process.env.LANE_PORT ?? "3293";
const BASE = process.env.LANE_BASE ?? `http://localhost:${PORT}`;
const OUT = process.env.LANE_OUT ?? "/tmp";
const EMAIL = process.env.LANE_EMAIL;
const PASSWORD = process.env.LANE_PASSWORD;

const ctx = await chromium.launchPersistentContext(path.join(OUT, ".browser-s6-2093"), {
  headless: true,
  viewport: { width: 1440, height: 1100 },
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));

await page.goto(`${BASE}/sign-up`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);

const fields = await page.evaluate(() =>
  Array.from(document.querySelectorAll("input")).map((i) => ({
    name: i.getAttribute("name"),
    type: i.getAttribute("type"),
    id: i.id,
  })),
);
console.log("SIGNUP_FIELDS", JSON.stringify(fields));

const nameInput = page.locator('input[name="name"]').first();
if (await nameInput.count()) await nameInput.fill("Lane 2093 Operator");
const userInput = page.locator('input[name="username"]').first();
if (await userInput.count()) await userInput.fill("lane2093op");
await page.fill('input[type="email"]', EMAIL);
const pwds = page.locator('input[type="password"]');
const n = await pwds.count();
for (let i = 0; i < n; i++) await pwds.nth(i).fill(PASSWORD);

await page.click('button[type="submit"]');
await page.waitForTimeout(8000);
console.log("POST_SIGNUP_URL", page.url());
await page.screenshot({ path: path.join(OUT, "signup-result.png"), fullPage: true });
await ctx.close();
