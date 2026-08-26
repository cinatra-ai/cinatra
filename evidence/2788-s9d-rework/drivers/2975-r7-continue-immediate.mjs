// PRESS CONTINUE ON THE SCHEDULER STEP WITH "Run right after setup" — the
// IMMEDIATE kind (cinatra#2970, PR #2975 round 7).
//
// Why the immediate kind and not a schedule: a scheduled/recurring trigger row
// takes the run page to the Trigger tab (`shouldShowPersistentTab`), and the
// cells this round owes are on the SETUP surface. An immediate trigger releases
// at once and is not a persistent tab, so the run executes while its page stays
// the two-column setup surface — which is where the review step is drawn.
//
// Nothing is written to the database here: the trigger row this reports is the
// app's own, read back after the app created it.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { Client } from "pg";

const APP = process.env.WALK_BASE;
const RUN_ID = process.env.WALK_RUN_ID;
const RUN_PAGE = process.env.WALK_RUN_PAGE;
const DB = process.env.SUPABASE_DB_URL;
const OUT = process.env.OUT_JSON;
for (const [n, v] of Object.entries({ WALK_BASE: APP, WALK_RUN_ID: RUN_ID, WALK_RUN_PAGE: RUN_PAGE, SUPABASE_DB_URL: DB, OUT_JSON: OUT }))
  if (!v) throw new Error(`the immediate-Continue driver needs ${n}`);

const db = new Client({ connectionString: DB });
await db.connect();
const state = async () => (await db.query(
  `SELECT r.status, r.started_at,
          (SELECT count(*) FROM cinatra.agent_run_triggers t WHERE t.run_id=r.id) AS triggers,
          now() AS read_at FROM cinatra.agent_runs r WHERE r.id=$1`, [RUN_ID])).rows[0];
const before = await state();
console.log(`before: status=${before.status} triggers=${before.triggers}`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ baseURL: APP, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const signIn = await ctx.request.post("/api/auth/sign-in/email", {
  headers: { Origin: APP },
  data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET },
});
if (!signIn.ok()) { console.log(`FAIL sign-in ${signIn.status()}`); process.exit(1); }
const page = await ctx.newPage();
page.setDefaultTimeout(300_000);
page.setDefaultNavigationTimeout(300_000);
await page.goto(RUN_PAGE, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-run-detail-column]');
await page.waitForTimeout(4000);
await page.locator('[data-run-detail-column]').getByRole("button", { name: "Run right after setup", exact: true }).first().click();
await page.waitForTimeout(1500);
const pressedAt = new Date().toISOString();
await page.locator('[data-run-detail-column]').getByRole("button", { name: "Continue", exact: true }).first().click();
console.log("PASS chose 'Run right after setup' and pressed Continue, inside the run detail column");
let after = before;
for (let i = 0; i < 60; i += 1) {
  await page.waitForTimeout(2000);
  after = await state();
  if (after.status !== before.status || Number(after.triggers) > Number(before.triggers)) break;
}
const trigger = (await db.query(`SELECT * FROM cinatra.agent_run_triggers WHERE run_id=$1`, [RUN_ID])).rows[0] ?? null;
console.log(`after: status=${after.status} trigger=${trigger ? `${trigger.trigger_type} released=${trigger.released_at ? "yes" : "no"}` : "none"}`);
console.log(`the app navigated to ${new URL(page.url()).pathname}`);
mkdirSync(dirname(resolve(OUT)), { recursive: true });
writeFileSync(resolve(OUT), `${JSON.stringify({ before, pressedAt, after, trigger, landedOn: new URL(page.url()).pathname }, null, 2)}\n`);
await db.end();
await browser.close();
