// THE SCHEDULE STEP'S OWN Continue, pressed on the run page with "Run right
// after setup" — then the run runs and this driver waits for the review gate
// the artifact opens. Nothing is inserted; the run's own rows are polled.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "@playwright/test";
import { Client } from "pg";

const BASE = process.env.WALK_BASE, DB = process.env.SUPABASE_DB_URL;
const RUN = process.env.WALK_RUN_ID, OUT = process.env.OUT_JSON;
const WAIT_MS = Number(process.env.WALK_REVIEW_WAIT_MS ?? 900000);
const db = new Client({ connectionString: DB }); await db.connect();
const b = await chromium.launch();
const ctx = await b.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage(); page.setDefaultTimeout(300_000);
await page.request.post("/api/auth/sign-in/email", { headers: { Origin: BASE }, data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET } });
const timeline = [];
const stamp = (w, x = {}) => { const e = { at: new Date().toISOString(), what: w, ...x }; timeline.push(e); console.log(`  · ${e.at} ${w} ${Object.keys(x).length ? JSON.stringify(x) : ""}`); };
const runRow = async () => (await db.query(`select status,lifecycle_moment,lifecycle_card_kind,lifecycle_card_ref,error from cinatra.agent_runs where id=$1`, [RUN])).rows[0];

await page.goto(process.env.WALK_RUN_PAGE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(14000);
stamp("the run page is open at the schedule step", await runRow());
const submit = page.locator('form button[type="submit"]').filter({ hasText: /continue|start|run/i }).first();
const n = await submit.count();
if (n === 0) {
  const all = await page.locator("button").allTextContents();
  stamp("NO schedule submit found", { buttons: all.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 20) });
  process.exit(1);
}
await submit.scrollIntoViewIfNeeded().catch(() => {});
const label = (await submit.textContent())?.replace(/\s+/g, " ").trim();
await submit.click();
stamp("the schedule step's own control was pressed", { label });

const started = Date.now();
let gate = null, last = null;
while (Date.now() - started < WAIT_MS) {
  last = await runRow();
  const gates = (await db.query(`select review_task_id, field_name, x_renderer, created_at from cinatra.agent_run_hitl_gates where run_id=$1 order by created_at`, [RUN])).rows;
  if (gates.length > 0) { gate = gates[gates.length - 1]; stamp("A GATE IS ON FILE", { gates: gates.length, reviewTaskId: gate.review_task_id, run: last }); break; }
  if (["failed", "cancelled"].includes(last.status)) { stamp("the run reached a terminal status with no gate", last); break; }
  await page.waitForTimeout(6000);
}
if (!gate) stamp("NO GATE within the window", { windowMs: WAIT_MS, run: last });
const out = { runId: RUN, gate, finalRun: await runRow(), timeline };
mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ gate: Boolean(gate), reviewTaskId: gate?.review_task_id ?? null, run: out.finalRun }, null, 1));
await db.end(); await b.close();
