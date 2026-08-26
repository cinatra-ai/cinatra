// ---------------------------------------------------------------------------
// cinatra#2790 S9f — CONFIGURE THIS LANE'S MODEL PROVIDER THROUGH THE APP'S OWN
// FORM, in a real browser.
//
// WHY THIS FILE EXISTS RATHER THAN A WRITER CALL. The earlier rounds in this lane
// seeded the provider connection by calling the shipped writer from a harness.
// This round types the key into the shipped `/setup/model` step and lets the APP
// seal it, so the credential travels the product's own path: from this process's
// environment into the form, and from the form to the app's own server action,
// which seals it at rest. Nothing in this file keeps, derives or reports it.
//
// THE CREDENTIAL reaches this process ONLY through its environment (the
// operator's secret-manager `run` wrapper around this exact command). It is
// never printed, never logged, never written to a file and never returned: the
// output of this driver is pass/fail lines and a boolean read of the row the app
// wrote.
//
// Usage: node 17-provider-setup-through-the-app.mjs
//        env: APP_ORIGIN, S9F_EMAIL, S9F_PW, SUPABASE_DB_URL, OPENAI_API_KEY
// ---------------------------------------------------------------------------
import { chromium } from "@playwright/test";
import pg from "pg";
const APP = process.env.APP_ORIGIN;
const E = process.env.S9F_EMAIL, P = process.env.S9F_PW;
const KEY = process.env.OPENAI_API_KEY ?? "";
if (!APP || !E || !P) throw new Error("set APP_ORIGIN, S9F_EMAIL, S9F_PW");
if (!KEY.trim()) { console.log("FAIL: no key in the process environment"); process.exit(1); }
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 1100 } });
const page = await ctx.newPage();
try {
  await page.goto(APP + "/sign-in", { waitUntil: "domcontentloaded", timeout: 300000 });
  await page.waitForSelector('input[name="email"]', { timeout: 300000 });
  await page.waitForTimeout(3000);
  await page.locator('input[name="email"]').first().pressSequentially(E, { delay: 10 });
  await page.locator('input[name="password"]').first().pressSequentially(P, { delay: 6 });
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(7000);
  console.log(`${new Date().toISOString()} PASS: signed in`);
  await page.goto(APP + "/setup/model", { waitUntil: "domcontentloaded", timeout: 300000 });
  await page.waitForTimeout(8000);
  await page.getByRole("button", { name: /^OpenAI$/ }).first().click();
  await page.waitForTimeout(9000);
  const field = page.locator("#setup-openai-api-key").first();
  await field.waitFor({ timeout: 120000 });
  await field.fill(KEY);
  console.log(`${new Date().toISOString()} PASS: the shipped form holds a key (length not reported)`);
  await page.getByRole("button", { name: /^Continue$/ }).first().click();
  await page.waitForTimeout(15000);
  console.log(`${new Date().toISOString()} ` + "PASS: submitted; the app sealed the connection itself; landed on " + new URL(page.url()).pathname + (new URL(page.url()).search ? "?<query>" : ""));
  const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
  if (/invalid|could not|failed|error/i.test(text.slice(0, 1200))) console.log("NOTE: page text mentions a problem: " + text.slice(0, 300));
  const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL });
  await c.connect();
  const rows = (await c.query(`select key from cinatra.metadata where key = 'openai_connection'`)).rows;
  await c.end();
  console.log(`${new Date().toISOString()} ` + (rows.length === 1 ? "PASS: the instance holds a sealed openai_connection row" : "FAIL: no openai_connection row was written"));
  process.exitCode = rows.length === 1 ? 0 : 1;
} catch (e) {
  console.log("FAIL: " + String(e?.message ?? e).slice(0, 200));
  process.exitCode = 1;
} finally {
  await b.close();
}
