// S9c round-2 capture, step 1 — create the instance owner through the REAL
// first-owner sign-up surface, then save the session the later steps reuse.
//
// Nothing here writes a row directly: the account is made by the shipped
// Better Auth sign-up the setup surface drives.
//
// Usage: node 01-signup.mjs <baseUrl> <outDir>
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv[2] || "http://localhost:3251";
const OUT = process.argv[3] || "/tmp/isl2754-session";
mkdirSync(OUT, { recursive: true });

export const CAPTURE_ACTOR = {
  name: "2754 Island Capture Owner",
  username: "isl2754",
  email: "island-2754@example.com",
  password: "island-2754-dev-12345",
};

const log = [];
const say = (m) => {
  log.push(m);
  console.log(m);
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();

try {
  await page.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  say(`landed on ${page.url()}`);

  if (new URL(page.url()).pathname.startsWith("/setup/account")) {
    await page.fill('input[name="name"]', CAPTURE_ACTOR.name);
    await page.fill('input[name="username"]', CAPTURE_ACTOR.username);
    await page.fill('input[name="email"]', CAPTURE_ACTOR.email);
    await page.fill('input[name="password"]', CAPTURE_ACTOR.password);
    await page.fill('input[name="confirmPassword"]', CAPTURE_ACTOR.password);
    await page.screenshot({ path: join(OUT, "signup-filled.png"), fullPage: true });
    await page.click('button:has-text("Continue")');
    await page
      .waitForURL((u) => !u.pathname.startsWith("/setup/account"), { timeout: 180_000 })
      .catch(() => {});
    say(`after sign-up: ${page.url()}`);
  }

  // Walk whatever the setup flow puts in front of the app, up to a bounded number
  // of steps, and stop as soon as a real app surface answers.
  for (let step = 0; step < 12; step += 1) {
    const path = new URL(page.url()).pathname;
    if (!path.startsWith("/setup")) break;
    const next = page.locator('button:has-text("Continue"), button:has-text("Next"), button:has-text("Skip"), button:has-text("Finish")').first();
    if ((await next.count()) === 0) break;
    const label = (await next.textContent().catch(() => ""))?.trim();
    await next.click({ timeout: 30_000 }).catch(() => {});
    await page.waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    say(`setup step ${step}: pressed "${label}" -> ${page.url()}`);
  }

  await page.goto(`${BASE}/agents`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.waitForTimeout(2000);
  const signedIn = !new URL(page.url()).pathname.startsWith("/sign-in");
  say(`/agents -> ${page.url()} signedIn=${signedIn}`);
  await page.screenshot({ path: join(OUT, "agents.png"), fullPage: true });
  await ctx.storageState({ path: join(OUT, "state.json") });
  say(`storage state written to ${join(OUT, "state.json")}`);
  if (!signedIn) throw new Error("sign-up did not produce a session");
} finally {
  writeFileSync(join(OUT, "01-signup.log"), log.join("\n") + "\n");
  await browser.close();
}
console.log("signup done");
