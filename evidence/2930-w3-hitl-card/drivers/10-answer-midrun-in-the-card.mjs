// PRESS THE CARD'S OWN CONTINUE — `[data-action="submit-hitl-screen"]` — on the
// mid-run question, in the conversation the run was started from, and read the
// run back. Then follow the run to wherever it settles and report every review
// gate it opened, so the review page's own reading can be established from rows
// rather than from a guess.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { Client } from "pg";
const APP = process.env.WALK_BASE, DB = process.env.SUPABASE_DB_URL, RUN = process.env.WALK_RUN_ID,
      THREAD = process.env.WALK_THREAD_URL, OUT = process.env.OUT_JSON;
for (const [n, v] of Object.entries({ WALK_BASE: APP, SUPABASE_DB_URL: DB, WALK_RUN_ID: RUN, WALK_THREAD_URL: THREAD, OUT_JSON: OUT })) if (!v) throw new Error(`needs ${n}`);
const db = new Client({ connectionString: DB }); await db.connect();
const readRun = async () => (await db.query(
  `SELECT id, status, started_at, completed_at, a2a_task_id, lifecycle_moment, lifecycle_card_ref, input_params, now() AS read_at FROM cinatra.agent_runs WHERE id=$1`, [RUN])).rows[0];
const readGates = async () => (await db.query(`SELECT review_task_id, x_renderer, field_name, created_at FROM cinatra.agent_run_hitl_gates WHERE run_id=$1 ORDER BY created_at`, [RUN])).rows;
const readReviews = async () => (await db.query(`SELECT * FROM cinatra.artifact_review_gates WHERE run_id=$1`, [RUN])).rows;
const before = { run: await readRun(), gates: await readGates(), reviewGates: await readReviews() };
console.log(`BEFORE status=${before.run.status} gates=${before.gates.length} reviewGates=${before.reviewGates.length}`);
const browser = await chromium.launch();
const ctx = await browser.newContext({ baseURL: APP, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const si = await ctx.request.post("/api/auth/sign-in/email", { headers: { Origin: APP }, data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET } });
if (!si.ok()) throw new Error(`sign-in ${si.status()}`);
const page = await ctx.newPage(); page.setDefaultTimeout(300_000); page.setDefaultNavigationTimeout(300_000);
await page.goto(THREAD, { waitUntil: "domcontentloaded" });
const btn = page.locator('[data-action="submit-hitl-screen"]').first();
await btn.waitFor({ timeout: 300_000 });
await page.waitForTimeout(5000);
await btn.scrollIntoViewIfNeeded();
const pressedAt = new Date().toISOString();
await btn.click();
console.log(`pressed the card's own Continue at ${pressedAt}`);
let moved = null;
for (let i = 0; i < 180; i += 1) {
  const r = await readRun();
  if (r.status !== before.run.status) { moved = r; break; }
  await page.waitForTimeout(1000);
}
console.log(`the run moved to ${moved?.status ?? "(unchanged)"}`);
// Follow it to rest.
let settled = moved ?? (await readRun());
for (let i = 0; i < 240; i += 1) {
  settled = await readRun();
  if (["completed", "failed", "cancelled", "pending_approval"].includes(settled.status) && i > 4) break;
  await page.waitForTimeout(2000);
}
await page.waitForTimeout(20000);
const cardsNow = await page.evaluate(() => Array.from(document.querySelectorAll("[data-lifecycle-card]")).map((e) => ({ kind: e.getAttribute("data-lifecycle-card"), host: e.getAttribute("data-lifecycle-card-host"), state: e.getAttribute("data-lifecycle-card-state") })));
await browser.close();
const after = { run: await readRun(), gates: await readGates(), reviewGates: await readReviews() };
await db.end();
mkdirSync(dirname(resolve(OUT)), { recursive: true });
writeFileSync(OUT, `${JSON.stringify({ runId: RUN, pressedAt, before, moved, settled, after, cardsInTranscriptAfter: cardsNow }, null, 2)}\n`);
console.log(JSON.stringify({ before: before.run.status, moved: moved?.status, settled: after.run.status, gates: after.gates.length, reviewGates: after.reviewGates.length, cardsNow }, null, 2));
