// One-off: create the lane's proof account through the REAL sign-up surface.
import { chromium } from "@playwright/test";
import path from "node:path";

const PORT = process.env.LANE_PORT ?? "3164";
const BASE = process.env.LANE_BASE ?? `http://localhost:${PORT}`;
const OUT = process.env.LANE_OUT;
const EMAIL = process.env.LANE_EMAIL;
const PASSWORD = process.env.LANE_PASSWORD;

const ctx = await chromium.launchPersistentContext(path.join(OUT, ".browser-signup"), {
  headless: true,
  viewport: { width: 1440, height: 1000 },
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));

await page.goto(`${BASE}/sign-up`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);

const fields = await page.evaluate(() =>
  Array.from(document.querySelectorAll("input")).map((i) => ({
    name: i.getAttribute("name"),
    type: i.getAttribute("type"),
    id: i.id,
    placeholder: i.getAttribute("placeholder"),
  })),
);
console.log("SIGNUP_FIELDS", JSON.stringify(fields));

const nameInput = page.locator('input[name="name"]').first();
if (await nameInput.count()) await nameInput.fill("Lane 2164 Proof");
const userInput = page.locator('input[name="username"]').first();
if (await userInput.count()) await userInput.fill(process.env.LANE_USERNAME ?? "lane2164b");
await page.fill('input[type="email"]', EMAIL);
const pwds = page.locator('input[type="password"]');
const n = await pwds.count();
for (let i = 0; i < n; i++) await pwds.nth(i).fill(PASSWORD);

await page.click('button[type="submit"]');
await page.waitForTimeout(6000);
console.log("POST_SIGNUP_URL", page.url());
await page.screenshot({ path: path.join(OUT, "signup-result.png") });
await ctx.close();
