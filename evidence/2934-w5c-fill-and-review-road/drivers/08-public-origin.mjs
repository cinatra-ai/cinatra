// W5c picture leg — store the instance's own public origin THROUGH THE APP'S
// OWN SCREEN (/configuration/development?tab=tunnel). The funnel itself is not
// touched: only the value the instance keeps for it is typed here, and it is
// read back off the re-rendered field afterwards.
//   env: APP_ORIGIN, ADMIN_EMAIL, ADMIN_PW, PUBLIC_ORIGIN
import { chromium } from "@playwright/test";

const APP = process.env.APP_ORIGIN;
const ORIGIN = process.env.PUBLIC_ORIGIN;
if (!APP || !ORIGIN) throw new Error("08-public-origin needs APP_ORIGIN and PUBLIC_ORIGIN");

const browser = await chromium.launch();
const ctx = await browser.newContext({ baseURL: APP, viewport: { width: 1440, height: 900 } });
const signIn = await ctx.request.post("/api/auth/sign-in/email", {
  headers: { Origin: APP },
  data: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PW },
});
console.log(`${new Date().toISOString()} admin sign-in ${signIn.status()}`);
const page = await ctx.newPage();
page.setDefaultTimeout(300000);
page.setDefaultNavigationTimeout(300000);
await page.goto("/configuration/development?tab=tunnel", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(8000);
console.log(`${new Date().toISOString()} landed on ${new URL(page.url()).pathname}${new URL(page.url()).search}`);
const field = page.locator("#publicBaseUrl");
await field.waitFor({ state: "visible" });
const before = await field.inputValue();
await field.fill(ORIGIN);
await page.waitForTimeout(500);
await page.getByRole("button", { name: /^Save$/ }).click();
await page.waitForTimeout(6000);
await page.goto("/configuration/development?tab=tunnel", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
const after = await page.locator("#publicBaseUrl").inputValue();
console.log(JSON.stringify({ before, after, matches: after.trim() === ORIGIN.trim() }, null, 2));
await browser.close();
if (after.trim() !== ORIGIN.trim()) process.exit(1);
