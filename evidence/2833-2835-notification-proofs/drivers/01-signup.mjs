// Step 1 — create the instance owner through the app's OWN first-owner surface,
// then save the session for the capture steps. No fixture identity, no seeded
// row: the actor these proofs run as is a real Better Auth sign-up.
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.argv[2] || "http://localhost:3838";
const OUT = process.argv[3] || "/Users/marcushorndt/cinatra-worktrees/x2838f-artifacts/session";
mkdirSync(OUT, { recursive: true });

const ACTOR = {
  name: "Notification Proof Owner",
  username: "notifproof",
  email: "notif-proof@example.com",
  password: "notif-proof-dev-12345",
};

const log = [];
const say = (m) => { log.push(m); console.log(m); };

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
try {
  await page.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
  say(`landed on ${page.url()}`);

  await page.fill('input[name="name"]', ACTOR.name);
  await page.fill('input[name="username"]', ACTOR.username);
  await page.fill('input[name="email"]', ACTOR.email);
  await page.fill('input[name="password"]', ACTOR.password);
  await page.fill('input[name="confirmPassword"]', ACTOR.password);
  await page.screenshot({ path: `${OUT}/01-signup-filled.png`, fullPage: true });
  await page.click('button:has-text("Continue")');
  await page.waitForLoadState("networkidle", { timeout: 120_000 }).catch(() => {});
  say(`after sign-up: ${page.url()}`);

  // Walk whatever setup steps remain until a signed-in app surface answers.
  for (let i = 0; i < 12; i += 1) {
    if (!page.url().includes("/setup")) break;
    const next = page.locator('button:has-text("Continue"), button:has-text("Finish"), button:has-text("Next"), button:has-text("Skip")').first();
    if ((await next.count()) === 0) break;
    await next.click().catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
    say(`setup step ${i}: ${page.url()}`);
  }

  await page.goto(`${BASE}/agents`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
  const signedIn = !page.url().includes("/sign-in");
  say(`/agents -> ${page.url()} signedIn=${signedIn}`);
  await page.screenshot({ path: `${OUT}/02-agents.png`, fullPage: true });

  await ctx.storageState({ path: `${OUT}/state.json` });
  say(`storage state written to ${OUT}/state.json`);
} finally {
  writeFileSync(`${OUT}/01-signup.log`, log.join("\n") + "\n");
  await browser.close();
}
