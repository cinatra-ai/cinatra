/**
 * Sign the acceptance operator back in through the REAL sign-in form
 * (cinatra#2094 F7/F11 fix-verification run).
 *
 * WHY this exists alongside `signup.mjs`: the S7 round-1 lane ran with the
 * documented browser-e2e switch present in its env, which also relaxes the
 * auth route guard (`src/lib/auth-route-guard.ts`). This fix-verification run
 * deliberately runs WITHOUT that switch, so `/chat` enforces the real
 * cookie-session wall and the persistent Chromium profile has to hold a REAL
 * session across drivers. When it does not (a fresh profile, or a guard-driven
 * redirect between arms), this driver re-establishes it through the same form a
 * human uses — never by seeding a session row.
 *
 * Fails LOUD (non-zero) when the post-sign-in landing is still an auth wall, so
 * a driver that silently proceeds to "no-composer" can never be mistaken for a
 * product finding again.
 */
import { chromium } from "@playwright/test";
import path from "node:path";
import process from "node:process";

const PORT = process.env.LANE_PORT ?? "3294";
const BASE = process.env.LANE_BASE ?? `http://localhost:${PORT}`;
const PROFILE = process.env.LANE_PROFILE;
const SHOTS = process.env.LANE_SHOTS;
const EMAIL = process.env.LANE_EMAIL;
const PASSWORD = process.env.LANE_PASSWORD;
const TARGET = process.env.LANE_SIGNIN_TARGET ?? "/chat";

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
page.setDefaultTimeout(120_000);

await page.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);

// IDEMPOTENT: an already-signed-in profile is bounced off /sign-in (or shows no
// form), so there is nothing to submit. Re-submitting a form that is not there
// used to abort the whole driver on a 120 s locator timeout — a driver defect
// that reads exactly like a product failure. Detect the form; skip when absent.
const submit = page.locator('button[type="submit"]');
if ((await submit.count()) > 0 && /\/sign-in/.test(page.url())) {
  // The form labels the identifier "Username" but accepts the e-mail; fill every
  // text-ish identifier field the page offers so either shape works.
  const ident = page.locator('input[name="email"], input[type="email"], input[name="username"]');
  const identCount = await ident.count();
  for (let i = 0; i < identCount; i++) await ident.nth(i).fill(EMAIL);
  const pwds = page.locator('input[type="password"]');
  const pwdCount = await pwds.count();
  for (let i = 0; i < pwdCount; i++) await pwds.nth(i).fill(PASSWORD);
  await submit.first().click();
  await page.waitForTimeout(8000);
} else {
  console.log("SIGNIN SKIPPED — the profile already holds a session");
}

await page.goto(`${BASE}${TARGET}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
const url = page.url();
await page.screenshot({ path: path.join(SHOTS, "signin-landing.png"), fullPage: true });
console.log("SIGNIN_TARGET_URL", url);
await ctx.close();

if (/\/sign-in|\/sign-up/.test(url)) {
  console.error("SIGNIN FAILED — still on an auth wall; refusing to report a session");
  process.exit(1);
}
console.log("SIGNIN OK");
