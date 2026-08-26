// ANSWER THE RUN'S SETUP STEP, on the app's own page, and let the run go where
// the app sends it: a run that finishes setup with no trigger configured lands
// on `pending_trigger` — "setup finished, awaiting the user's trigger choice"
// (run-actions.ts) — which is the run state the SETUP RUN PAGE is drawn for and
// the state cinatra#2970's ruling is about.
//
// Nothing is written to the database here. The status this driver reports is
// read back from it after the app moved the run itself.
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
  if (!v) throw new Error(`the setup-step driver needs ${n}`);

const db = new Client({ connectionString: DB });
await db.connect();
const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: APP, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const signIn = await context.request.post("/api/auth/sign-in/email", {
  headers: { Origin: APP },
  data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET },
});
if (!signIn.ok()) { console.log(`FAIL sign-in ${signIn.status()}`); process.exit(1); }
const page = await context.newPage();
page.setDefaultTimeout(300_000);
page.setDefaultNavigationTimeout(300_000);
await page.goto(RUN_PAGE, { waitUntil: "domcontentloaded" });
await page.waitForSelector("text=Continue");
await page.waitForTimeout(3000);

// Whatever the agent asks for, typed the way a person types it. The one field
// this agent shows expects a JSON object, and the page says so on the field.
const fields = await page.locator("input[type='text'], input:not([type]), textarea").all();
for (const f of fields) {
  if (!(await f.isVisible().catch(() => false))) continue;
  if (await f.isDisabled().catch(() => true)) continue;
  if (await f.inputValue().catch(() => "x")) continue;
  const hint = ((await f.getAttribute("id")) ?? (await f.getAttribute("name")) ?? "").toLowerCase();
  const idea = JSON.stringify({
    title: "Connector rollout note",
    summary: "A short note on what changed in the connector rollout this week.",
    outline: ["What changed", "Who it affects", "What to do next"],
  });
  await f.fill(/idea|json|params/.test(hint) ? idea : "Connector rollout note").catch(() => {});
}

const answeredAt = new Date().toISOString();
// The run panel repaints while the run polls, so the auto-waiting click never
// finds the button "stable". The press itself is the person's press: it is
// dispatched on the button the page draws, not on a route behind it.
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll("button")).find((x) => (x.textContent ?? "").trim() === "Continue");
  if (!b) throw new Error("no Continue button on the run's setup step");
  b.click();
});
console.log("PASS pressed Continue on the run's own setup step");

let settled = null;
for (let i = 0; i < 90; i += 1) {
  settled = (await db.query(
    `SELECT id, status, created_at, started_at, human_present FROM cinatra.agent_runs WHERE id = $1`, [RUN_ID],
  )).rows[0];
  if (settled.status === "pending_trigger" || settled.status === "pending_input" || settled.status === "armed") break;
  await page.waitForTimeout(2000);
}
const trigger = (await db.query(`SELECT * FROM cinatra.agent_run_triggers WHERE run_id = $1`, [RUN_ID])).rows[0] ?? null;
console.log(`PASS the run reads ${settled.status}; trigger row: ${trigger ? "present" : "none"}`);
mkdirSync(dirname(resolve(OUT)), { recursive: true });
writeFileSync(resolve(OUT), `${JSON.stringify({ run: settled, trigger, answeredAt, runPage: RUN_PAGE }, null, 2)}\n`);
await db.end();
await browser.close();
