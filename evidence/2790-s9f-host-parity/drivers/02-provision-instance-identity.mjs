// ---------------------------------------------------------------------------
// cinatra#2790 S9f — provision this lane's INSTANCE IDENTITY through the
// SHIPPED setup surface, in a real browser.
//
// WHY THIS DRIVER EXISTS. The lane database is a clone of an already-provisioned
// instance whose `cinatra.metadata` row `instance_identity` did not travel with
// it. Nothing notices until a run tries to PERSIST what it produced: the
// artifact-binding loader resolves the registry config from that row, and
// without it every materialization fails with
// `INSTANCE_NAMESPACE_NOT_CONFIGURED` — measured on the first WayFlow drive of
// this lane, AFTER the model call had already answered 200.
//
// It is LANE DATA, not code, and it is provisioned the way the product
// provisions it: the shipped `/setup/name` wizard step, filled and submitted in
// a browser. Nothing is written into `cinatra.metadata` by hand.
//
// No origin is hard-coded: the app origin is read from the environment.
//
// Usage: node 02-provision-instance-identity.mjs <appOrigin> <namespace> <outDir>
//        env: S9F_EMAIL, S9F_PW
// ---------------------------------------------------------------------------
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const APP = process.argv[2];
const NAMESPACE = process.argv[3];
const OUT = process.argv[4];
const ACTOR = { email: process.env.S9F_EMAIL, password: process.env.S9F_PW };
if (!APP || !NAMESPACE || !OUT || !ACTOR.email || !ACTOR.password) {
  throw new Error("usage: 02-provision-instance-identity.mjs <appOrigin> <namespace> <outDir>; set S9F_EMAIL, S9F_PW");
}
mkdirSync(OUT, { recursive: true });

const log = [];
const say = (m) => { log.push(m); console.log(m); };

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
const page = await ctx.newPage();

async function signIn() {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await page.goto(`${APP}/sign-in`, { waitUntil: "domcontentloaded", timeout: 300_000 });
    await page.waitForSelector('input[name="email"]', { timeout: 300_000 });
    await page.waitForTimeout(4000);
    const em = page.locator('input[name="email"]').first();
    const pw = page.locator('input[name="password"]').first();
    await em.click();
    await em.pressSequentially(ACTOR.email, { delay: 12 });
    await pw.click();
    await pw.pressSequentially(ACTOR.password, { delay: 6 });
    if ((await em.inputValue()) !== ACTOR.email) continue;
    await page.locator('button[type="submit"]').first().click();
    for (let i = 0; i < 60; i += 1) {
      await page.waitForTimeout(2000);
      if (!new URL(page.url()).pathname.startsWith("/sign-in")) return new URL(page.url()).pathname;
    }
  }
  throw new Error("sign-in did not leave /sign-in");
}

try {
  say(`# cinatra#2790 S9f instance-identity provisioning — ${new Date().toISOString()}`);
  say(`after sign-in: ${await signIn()}`);
  await page.goto(`${APP}/setup/name`, { waitUntil: "domcontentloaded", timeout: 300_000 });
  await page.waitForTimeout(6000);
  // ORDER MATTERS on this form: typing the display name AUTO-FILLS the
  // namespace until the namespace is edited directly, so the display name is
  // typed FIRST and the namespace second. The Continue button is gated on the
  // namespace validator, so this waits for the button to become enabled rather
  // than clicking a disabled control and calling the absence of a write a
  // finding.
  const display = page.locator("#instance-display-name").first();
  await display.waitFor({ timeout: 120_000 });
  await display.click();
  await display.fill("");
  await display.pressSequentially("S9f Capture Lane", { delay: 20 });
  await page.waitForTimeout(1500);

  const ns = page.locator('input[name="instanceNamespace"]').first();
  await ns.waitFor({ timeout: 120_000 });
  await ns.click();
  await ns.fill("");
  await ns.pressSequentially(NAMESPACE, { delay: 25 });
  await page.waitForTimeout(2500);
  say(`FIELDS display="${await display.inputValue()}" namespace="${await ns.inputValue()}"`);

  const submit = page.getByRole("button", { name: /Continue/i }).first();
  for (let i = 0; i < 40; i += 1) {
    if (await submit.isEnabled().catch(() => false)) break;
    await page.waitForTimeout(1000);
  }
  say(`submit enabled: ${await submit.isEnabled().catch(() => false)}`);
  await submit.click({ timeout: 120_000 });
  say("SUBMIT pressed on /setup/name");
  for (let i = 0; i < 40; i += 1) {
    await page.waitForTimeout(3000);
    if (!new URL(page.url()).pathname.startsWith("/setup/name")) break;
  }
  say(`after submit: ${new URL(page.url()).pathname}`);
  say(`page text: ${(await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, "\n"))).slice(0, 600)}`);
  say("PROVISION OK");
} catch (e) {
  say(`PROVISION ERROR: ${e?.stack || e}`);
  await page.screenshot({ path: join(OUT, "provision-error.png"), fullPage: true }).catch(() => {});
} finally {
  writeFileSync(join(OUT, "provision-identity.log"), log.join("\n") + "\n");
  await browser.close();
}
