// PRESS "Run right after setup" AND Continue on the run's own trigger step, so
// the run leaves the setup surface and is dispatched to the agent runtime. The
// app creates the trigger row and releases it; nothing here writes one.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { Client } from "pg";
const APP = process.env.WALK_BASE, RUN = process.env.WALK_RUN_ID, PAGE = process.env.WALK_RUN_PAGE, DB = process.env.SUPABASE_DB_URL, OUT = process.env.OUT_JSON;
for (const [n, v] of Object.entries({ WALK_BASE: APP, WALK_RUN_ID: RUN, WALK_RUN_PAGE: PAGE, SUPABASE_DB_URL: DB, OUT_JSON: OUT })) if (!v) throw new Error(`needs ${n}`);
const db = new Client({ connectionString: DB }); await db.connect();
const state = async () => (await db.query(
  `SELECT r.status, r.started_at, r.a2a_task_id, r.lifecycle_moment, r.lifecycle_card_ref,
          (SELECT count(*) FROM cinatra.agent_run_triggers t WHERE t.run_id=r.id) AS triggers,
          (SELECT count(*) FROM cinatra.agent_run_hitl_gates g WHERE g.run_id=r.id) AS gates,
          now() AS read_at FROM cinatra.agent_runs r WHERE r.id=$1`, [RUN])).rows[0];
const before = await state();
console.log(`before: status=${before.status} triggers=${before.triggers} gates=${before.gates}`);
const browser = await chromium.launch();
const ctx = await browser.newContext({ baseURL: APP, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const si = await ctx.request.post("/api/auth/sign-in/email", { headers: { Origin: APP }, data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET } });
if (!si.ok()) throw new Error(`sign-in ${si.status()}`);
const page = await ctx.newPage(); page.setDefaultTimeout(300_000); page.setDefaultNavigationTimeout(300_000);
await page.goto(PAGE, { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: "Run right after setup", exact: true }).first().waitFor();
await page.getByRole("button", { name: "Run right after setup", exact: true }).first().click();
await page.waitForTimeout(1500);
const pressedAt = new Date().toISOString();
await page.getByRole("button", { name: "Continue", exact: true }).first().click();
console.log(`pressed Continue on the trigger step at ${pressedAt}`);
const seen = [];
let last = before.status;
for (let i = 0; i < 300; i += 1) {
  const s = await state();
  if (s.status !== last || Number(s.gates) !== Number(before.gates)) { seen.push({ at: new Date().toISOString(), ...s }); console.log(`  · ${s.status} started_at=${s.started_at} a2a=${s.a2a_task_id} gates=${s.gates} moment=${s.lifecycle_moment}`); last = s.status; }
  if (s.status === "pending_approval" && Number(s.gates) > Number(before.gates)) break;
  if (["completed", "failed", "cancelled"].includes(s.status)) break;
  await page.waitForTimeout(2000);
}
const final = await state();
const gates = (await db.query(`SELECT review_task_id, x_renderer, field_name, created_at FROM cinatra.agent_run_hitl_gates WHERE run_id=$1 ORDER BY created_at`, [RUN])).rows;
await browser.close(); await db.end();
mkdirSync(dirname(resolve(OUT)), { recursive: true });
writeFileSync(OUT, `${JSON.stringify({ runId: RUN, pressedAt, before, transitions: seen, final, gates }, null, 2)}\n`);
console.log(JSON.stringify({ final: final.status, a2a: final.a2a_task_id, gates }, null, 2));
