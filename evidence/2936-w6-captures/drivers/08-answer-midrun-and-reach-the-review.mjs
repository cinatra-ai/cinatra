// THE MID-RUN GATE, ANSWERED ON THE CARD (the run page's own Continue), and
// then the wait for the artifact review the run's output opens. Nothing is
// inserted; the run's own rows are polled.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "@playwright/test";
import { Client } from "pg";
const BASE = process.env.WALK_BASE, DB = process.env.SUPABASE_DB_URL, RUN = process.env.WALK_RUN_ID, OUT = process.env.OUT_JSON;
const WAIT_MS = Number(process.env.WALK_REVIEW_WAIT_MS ?? 1200000);
const db = new Client({ connectionString: DB }); await db.connect();
const b = await chromium.launch();
const ctx = await b.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage(); page.setDefaultTimeout(300_000);
await page.request.post("/api/auth/sign-in/email", { headers: { Origin: BASE }, data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET } });
const timeline = [];
const stamp = (w, x = {}) => { const e = { at: new Date().toISOString(), what: w, ...x }; timeline.push(e); console.log(`  · ${e.at} ${w} ${Object.keys(x).length ? JSON.stringify(x) : ""}`); };
const runRow = async () => (await db.query(`select status,lifecycle_moment,lifecycle_card_kind,lifecycle_card_ref,left(coalesce(error,''),200) err from cinatra.agent_runs where id=$1`, [RUN])).rows[0];
const gates = async () => (await db.query(`select review_task_id, field_name, x_renderer, created_at from cinatra.agent_run_hitl_gates where run_id=$1 order by created_at`, [RUN])).rows;

for (let round = 0; round < 6; round += 1) {
  const r = await runRow();
  if (["completed", "failed", "cancelled"].includes(r.status)) { stamp("terminal", r); break; }
  const g = await gates();
  if (g.some((x) => !String(x.review_task_id).startsWith("setup-") && !String(x.review_task_id).startsWith("wayflow-"))) { stamp("an artifact review gate is on file", { gates: g.map((x) => x.review_task_id) }); break; }
  await page.goto(process.env.WALK_RUN_PAGE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(14000);
  const cards = await page.evaluate(() => Array.from(document.querySelectorAll("[data-lifecycle-card]")).map((e) => e.getAttribute("data-lifecycle-card") + "/" + e.getAttribute("data-lifecycle-card-state")));
  stamp("the run page draws", { cards, run: r });
  const cont = page.locator('[data-action="submit-hitl-screen"]').first();
  if ((await cont.count()) === 0) {
    stamp("no card Continue on the run page — waiting", { round });
    for (let i = 0; i < 40; i += 1) { await page.waitForTimeout(15000); const rr = await runRow(); if (rr.status !== r.status || rr.lifecycle_card_kind !== r.lifecycle_card_kind) { stamp("the run moved", rr); break; } }
    continue;
  }
  const fields = page.locator('[data-conformance-id="hitl-screen-fields"]');
  const box = fields.locator("textarea, input[type='text'], input:not([type])").first();
  if ((await box.count()) > 0 && process.env.WALK_MIDRUN_ANSWER) await box.fill(process.env.WALK_MIDRUN_ANSWER).catch(() => {});
  await cont.scrollIntoViewIfNeeded().catch(() => {});
  await cont.click();
  stamp("the mid-run gate was answered through the card's own Continue");
  await page.waitForTimeout(20000);
}

const started = Date.now();
let review = null, last = null;
while (Date.now() - started < WAIT_MS) {
  last = await runRow();
  const g = await gates();
  const artifact = g.find((x) => !String(x.review_task_id).startsWith("setup-") && !String(x.review_task_id).startsWith("wayflow-"));
  if (artifact) { review = artifact; stamp("THE ARTIFACT REVIEW GATE IS ON FILE", { reviewTaskId: artifact.review_task_id, run: last }); break; }
  if (["failed", "cancelled"].includes(last.status)) { stamp("terminal with no review", last); break; }
  await page.waitForTimeout(10000);
}
if (!review) stamp("NO artifact review gate within the window", { windowMs: WAIT_MS, run: last, gates: (await gates()).map((x) => x.review_task_id) });
const out = { runId: RUN, review, finalRun: await runRow(), gates: await gates(), timeline };
mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ review: review?.review_task_id ?? null, run: out.finalRun }, null, 1));
await db.end(); await b.close();
