// PRESS CONTINUE ON THE SCHEDULER STEP — cinatra#2970 acceptance item 2,
// "Continue arms it exactly as today".
//
// The press is the person's press, delivered on the button the page draws
// inside the run surface's DETAIL column, after choosing "Schedule for later"
// and typing an instant into the step's own field. Nothing is written to the
// database here: the trigger row this reports is the app's own, read back after
// the app created it.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { chromium } from "@playwright/test";
import { Client } from "pg";

const APP = process.env.WALK_BASE;
const RUN_ID = process.env.WALK_RUN_ID;
const RUN_PAGE = process.env.WALK_RUN_PAGE;
const DB = process.env.SUPABASE_DB_URL;
const OUT = process.env.OUT_JSON;
const WHEN = process.env.WALK_SCHEDULED_AT; // naive local datetime, e.g. 2026-08-26 18:45
for (const [n, v] of Object.entries({ WALK_BASE: APP, WALK_RUN_ID: RUN_ID, WALK_RUN_PAGE: RUN_PAGE, SUPABASE_DB_URL: DB, OUT_JSON: OUT, WALK_SCHEDULED_AT: WHEN }))
  if (!v) throw new Error(`the Continue driver needs ${n}`);

const db = new Client({ connectionString: DB });
await db.connect();
const before = (await db.query(
  `SELECT r.status, r.created_at, r.started_at,
          (SELECT count(*) FROM cinatra.agent_run_triggers t WHERE t.run_id = r.id) AS triggers,
          now() AS read_at
     FROM cinatra.agent_runs r WHERE r.id = $1`, [RUN_ID])).rows[0];
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
await page.waitForSelector('[data-run-detail-column] #scheduledAt');
await page.waitForTimeout(4000);

// "Schedule for later", with the instant typed into the step's own field. The
// field's own onChange is what selects the option, exactly as it does for a
// person typing into it.
await page.locator('[data-run-detail-column] #scheduledAt').fill(WHEN.replace(" ", "T"));
await page.waitForTimeout(1500);
const pressedAt = new Date().toISOString();
await page.getByRole("button", { name: "Continue", exact: true }).first().click();
console.log("PASS pressed Continue on the scheduler step, inside the run detail column");

let settled = null;
for (let i = 0; i < 60; i += 1) {
  await page.waitForTimeout(2000);
  settled = (await db.query(`SELECT id, status, started_at FROM cinatra.agent_runs WHERE id = $1`, [RUN_ID])).rows[0];
  if (settled.status !== before.status) break;
}
const trigger = (await db.query(`SELECT * FROM cinatra.agent_run_triggers WHERE run_id = $1`, [RUN_ID])).rows[0] ?? null;
const landedOn = new URL(page.url()).pathname;
console.log(`after: status=${settled.status} trigger=${trigger ? `${trigger.trigger_type} @ ${trigger.scheduled_at?.toISOString?.() ?? trigger.scheduled_at} ${trigger.timezone}` : "none"}`);
console.log(`the app navigated to ${landedOn}`);
mkdirSync(dirname(resolve(OUT)), { recursive: true });
writeFileSync(resolve(OUT), `${JSON.stringify({ before, pressedAt, after: settled, trigger, landedOn, typed: WHEN }, null, 2)}\n`);
await db.end();
await browser.close();
