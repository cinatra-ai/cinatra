/**
 * Create the acceptance operator account through the REAL sign-up surface
 * (cinatra#2094 S7 item 3a) — no row seeding, no session forgery. Runs in an
 * ISOLATED Chromium profile under the lane's own scratch dir, never the shared
 * MCP browser.
 *
 * Adapted from `evidence/2093-s6-setup/drivers/signup.mjs`.
 */
import { chromium } from "@playwright/test";
import path from "node:path";

const PORT = process.env.LANE_PORT ?? "3294";
const BASE = process.env.LANE_BASE ?? `http://localhost:${PORT}`;
const PROFILE = process.env.LANE_PROFILE;
const SHOTS = process.env.LANE_SHOTS;
const EMAIL = process.env.LANE_EMAIL;
const PASSWORD = process.env.LANE_PASSWORD;

if (!PROFILE || !SHOTS || !EMAIL || !PASSWORD) {
  console.error("LANE_PROFILE, LANE_SHOTS, LANE_EMAIL, LANE_PASSWORD are required");
  process.exit(1);
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  viewport: { width: 1440, height: 1200 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => {
  pageErrors.push(e.message);
  console.log("pageerror:", e.message);
});

await page.goto(`${BASE}/sign-up`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);

const nameInput = page.locator('input[name="name"]').first();
if (await nameInput.count()) await nameInput.fill("Lane 2094 Operator");
const userInput = page.locator('input[name="username"]').first();
if (await userInput.count()) await userInput.fill("lane2094op");
await page.fill('input[type="email"]', EMAIL);
const pwds = page.locator('input[type="password"]');
const n = await pwds.count();
for (let i = 0; i < n; i++) await pwds.nth(i).fill(PASSWORD);

await page.screenshot({ path: path.join(SHOTS, "00-signup-form.png"), fullPage: true });
await page.click('button[type="submit"]');
await page.waitForTimeout(9000);

console.log("POST_SIGNUP_URL", page.url());
console.log("PAGE_ERRORS", JSON.stringify(pageErrors));
await page.screenshot({ path: path.join(SHOTS, "01-post-signup.png"), fullPage: true });
await ctx.close();
