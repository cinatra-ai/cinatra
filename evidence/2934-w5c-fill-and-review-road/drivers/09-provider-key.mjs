// W5c picture leg — commit the instance's LLM provider THROUGH THE APP'S OWN
// SETUP FORM (/setup/model), driven from the operator's own machine against the
// instance's public origin. The key is read from the environment the vault
// wrapper provides and is NEVER printed, logged or written to disk: it goes
// from the environment into the form's own field and nowhere else.
//   env: APP_ORIGIN, ADMIN_EMAIL, ADMIN_PW, OPENAI_API_KEY
import { chromium } from "@playwright/test";

const APP = process.env.APP_ORIGIN;
const KEY = process.env.OPENAI_API_KEY;
if (!APP) throw new Error("09-provider-key needs APP_ORIGIN");
if (!KEY) throw new Error("09-provider-key needs OPENAI_API_KEY in the environment (vault wrapper)");

const browser = await chromium.launch();
const ctx = await browser.newContext({ baseURL: APP, viewport: { width: 1440, height: 900 } });
const signIn = await ctx.request.post("/api/auth/sign-in/email", {
  headers: { Origin: APP },
  data: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PW },
});
console.log(`${new Date().toISOString()} admin sign-in ${signIn.status()}`);
const page = await ctx.newPage();
page.setDefaultTimeout(600000);
page.setDefaultNavigationTimeout(600000);
await page.goto("/setup/model", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(9000);
console.log(`${new Date().toISOString()} on ${new URL(page.url()).pathname}`);

const pick = page.locator('[data-testid="setup-provider-openai"]');
if (await pick.count()) {
  await pick.click();
  await page.waitForTimeout(9000);
  console.log(`${new Date().toISOString()} provider chosen; on ${new URL(page.url()).pathname}`);
}
const field = page.locator("#setup-openai-api-key");
if (await field.count()) {
  await field.fill(KEY);                       // the value never leaves this line
  await page.waitForTimeout(800);
  const len = await field.evaluate((el) => el.value.length);
  console.log(`${new Date().toISOString()} the form's own field holds ${len} characters`);
  await page.locator('[data-testid="setup-ai-continue"]').click();
} else {
  console.log(`${new Date().toISOString()} no key field rendered — the step may already be ready`);
}
for (let i = 0; i < 40; i += 1) {
  await page.waitForTimeout(5000);
  const t = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 900));
  if (!/Saving|Submitting|Continuing/i.test(t)) {
    console.log(`${new Date().toISOString()} on ${new URL(page.url()).pathname} :: ${t.slice(0, 700)}`);
    break;
  }
}
await browser.close();
