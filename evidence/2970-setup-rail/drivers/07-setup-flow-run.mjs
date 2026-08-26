// A RUN AT THE TRIGGER STEP, made the way a person makes one: open the agent's
// own "new run" page, finish the setup step, and stop where the app stops — the
// schedule is not armed, so the run sits in `pending_trigger` ("setup finished,
// awaiting the user's trigger choice", run-actions.ts) with NO trigger row.
//
// WHY THIS RUN AND NOT THE SCHEDULED ONE. A run whose schedule has been
// CONFIRMED owns a persistent trigger row, and the run page then draws the
// Trigger tab rather than the setup rail (`showPersistentTab && trigger` in
// instance-screens.tsx). The setup run page — the screen cinatra#2970 changes,
// and the screen the ruling is about — is the one a run is on BEFORE its
// schedule is armed. That is this run.
//
// Nothing is inserted: the run row, its status and its steps are the app's own.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { chromium } from "@playwright/test";
import { Client } from "pg";

const BASE = process.env.WALK_BASE;
const AGENT_PATH = process.env.WALK_AGENT_PATH;
const DB = process.env.SUPABASE_DB_URL;
const OUT = process.env.OUT_JSON;
for (const [n, v] of Object.entries({ WALK_BASE: BASE, WALK_AGENT_PATH: AGENT_PATH, SUPABASE_DB_URL: DB, OUT_JSON: OUT }))
  if (!v) throw new Error(`the setup-flow driver needs ${n}`);

const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const signIn = await context.request.post("/api/auth/sign-in/email", {
  headers: { Origin: BASE },
  data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET },
});
console.log(signIn.ok() ? "PASS signed in" : `FAIL sign-in ${signIn.status()}`);
if (!signIn.ok()) process.exit(1);
const page = await context.newPage();
page.setDefaultTimeout(300_000);
page.setDefaultNavigationTimeout(300_000);

await page.goto(`${AGENT_PATH}/new`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("text=Continue");
const runId = page.url().split("/").pop();
console.log(`PASS the app created run ${runId} on its own setup step`);

await page.getByRole("button", { name: "Continue" }).first().click();
await page.waitForSelector("[data-run-surface-rail-step]", { timeout: 300_000 });
await page.waitForTimeout(3000);
console.log(`PASS the run reached the setup run page at ${new URL(page.url()).pathname}`);

const db = new Client({ connectionString: DB });
await db.connect();
const run = (await db.query(
  `SELECT r.id, r.status, r.created_at, r.started_at, r.human_present, r.source_type, t.package_name, t.name
     FROM cinatra.agent_runs r JOIN cinatra.agent_templates t ON t.id = r.template_id
    WHERE r.id = $1`, [runId],
)).rows[0];
const trigger = (await db.query(`SELECT * FROM cinatra.agent_run_triggers WHERE run_id = $1`, [runId])).rows[0] ?? null;
console.log(`PASS the run reads ${run.status} in the database, trigger row: ${trigger ? "present" : "none"}`);
const runUrl = new URL(page.url()).pathname;
mkdirSync(dirname(resolve(OUT)), { recursive: true });
writeFileSync(resolve(OUT), `${JSON.stringify({ run, trigger, runUrl, recordedAt: new Date().toISOString() }, null, 2)}\n`);
console.log(`PASS wrote ${OUT}`);
await db.end();
await browser.close();
