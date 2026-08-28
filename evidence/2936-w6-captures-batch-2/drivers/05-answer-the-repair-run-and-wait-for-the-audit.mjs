// THE REPAIR RUN'S OWN SETUP GATE, ANSWERED ON ITS OWN SCREEN.
//
// The change request resolved the base gate `changes_requested` and a repair
// went in flight (`cinatra.lifecycle_repair`, route `producer_repair`). The
// repair run then PARKED on the agent's own setup field rather than working the
// target from the reviewer's note — measured, and reported in README.md, because
// the drawing says the corrected version returns on its own. Nothing here works
// around that: the driver opens the repair run's OWN page and presses the card's
// OWN Continue, which is the screen the product draws for that park, and then
// waits for the successor review gate and the audit record.
//
// Nothing is inserted; every number is read back out of the rows.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "@playwright/test";
import { Client } from "pg";

const BASE = process.env.WALK_BASE, DB = process.env.SUPABASE_DB_URL;
const PARENT = process.env.WALK_RUN_ID, OUT = process.env.OUT_JSON;
const ANSWER = process.env.WALK_REPAIR_ANSWER ?? "";
const SLUG = process.env.WALK_AGENT_SLUG ?? "blog-draft-writer-agent";
const WAIT_MS = Number(process.env.WALK_AUDIT_WAIT_MS ?? 1200000);
for (const [n, v] of Object.entries({ WALK_BASE: BASE, SUPABASE_DB_URL: DB, WALK_RUN_ID: PARENT, OUT_JSON: OUT }))
  if (!v) throw new Error(`the repair driver needs ${n}`);

const db = new Client({ connectionString: DB }); await db.connect();
const timeline = [];
const stamp = (w, x = {}) => { const e = { at: new Date().toISOString(), what: w, detail: x }; timeline.push(e); console.log(`  · ${e.at} ${w} ${Object.keys(x).length ? JSON.stringify(x) : ""}`); };

const repairRun = (await db.query(
  `select id, status, parent_run_id, lifecycle_moment, lifecycle_card_kind, human_present, source_type, created_at
     from cinatra.agent_runs where parent_run_id=$1 and source_type='lifecycle_repair' order by created_at desc limit 1`, [PARENT])).rows[0];
if (!repairRun) { console.log("FAIL no repair run for this parent"); process.exit(1); }
stamp("the repair run the change request created", repairRun);

const b = await chromium.launch();
const ctx = await b.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage(); page.setDefaultTimeout(300_000);
await page.request.post("/api/auth/sign-in/email", { headers: { Origin: BASE }, data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET } });
const repairPage = `/agents/cinatra-ai/${SLUG}/${encodeURIComponent(repairRun.id)}`;
await page.goto(repairPage, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(14000);
stamp("the repair run's own page answers", { path: repairPage, httpReachable: true });

const fields = page.locator('[data-conformance-id="hitl-screen-fields"]');
if ((await fields.count()) > 0) {
  const box = fields.locator("textarea, input[type='text'], input:not([type])").first();
  if (ANSWER && (await box.count()) > 0) await box.fill(ANSWER).catch(() => {});
  const cont = page.locator('[data-action="submit-hitl-screen"]').first();
  if ((await cont.count()) > 0) { await cont.scrollIntoViewIfNeeded().catch(() => {}); await cont.click({ timeout: 120000 }); stamp("the repair run's setup gate was answered through the card's own Continue"); }
  else stamp("NO CONTINUE on the repair run's card");
} else stamp("NO HITL SCREEN CARD on the repair run's page");

const gates = async () => (await db.query(
  `select id, run_id, review_task_id, status, disposition, created_at from cinatra.artifact_review_gates order by created_at`)).rows;
const audits = async () => (await db.query(`select * from cinatra.artifact_verification_records order by created_at`)).rows;
const repairRow = async () => (await db.query(`select id,status,successor_gate_id,successor_artifact_id,change_summary,finding_outcomes,attempt,updated_at from cinatra.lifecycle_repair`)).rows;

const t0 = Date.now();
let successor = null, audit = null;
while (Date.now() - t0 < WAIT_MS) {
  const gs = await gates();
  const as = await audits();
  if (gs.length > 1 && !successor) { successor = gs[gs.length - 1]; stamp("A SUCCESSOR REVIEW GATE IS ON FILE", successor); }
  if (as.length > 0 && !audit) { audit = as[as.length - 1]; stamp("AN AUDIT (verification) RECORD IS ON FILE", { id: audit.id, outcome: audit.outcome ?? null }); }
  if (successor && audit) break;
  const rr = (await db.query(`select status from cinatra.agent_runs where id=$1`, [repairRun.id])).rows[0];
  if (["failed", "cancelled"].includes(rr?.status)) { stamp("the repair run reached a terminal status", rr); break; }
  await page.waitForTimeout(5000);
}
const out = {
  parentRunId: PARENT,
  repairRun,
  repairPage,
  successorGate: successor,
  auditRecord: audit,
  lifecycleRepair: await repairRow(),
  gates: await gates(),
  auditRecords: await audits(),
  timeline,
};
mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ successor: successor?.review_task_id ?? null, successorRunId: successor?.run_id ?? null, audits: out.auditRecords.length }, null, 1));
await db.end(); await b.close();
