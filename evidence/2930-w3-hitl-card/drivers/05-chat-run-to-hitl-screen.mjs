// A RUN DRIVEN TO A HITL SCREEN FROM THE APP'S OWN CHAT, with the real
// provider and the real public MCP toolbox. The person asks for the agent in
// their own words; the app's own dispatch creates the run; the run parks at the
// step that asks them for something. Nothing here inserts a run, a gate or a
// turn — the run is found BY DIFFERENCE against the rows that existed before.
//
// Same discipline as evidence/2970-setup-rail/drivers/08-chat-run-parked.mjs:
// a warm-up turn first (the model's hosted MCP connector fails its first
// tool-list fetch on a cold OAuth path), then the measured turn.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "@playwright/test";
import { Client } from "pg";

const APP = process.env.WALK_BASE;
const DB = process.env.SUPABASE_DB_URL;
const OUT = process.env.OUT_JSON;
const SENTENCE = process.env.WALK_SENTENCE;
const SERVER_LOG = process.env.SERVER_LOG;
for (const [n, v] of Object.entries({ WALK_BASE: APP, SUPABASE_DB_URL: DB, OUT_JSON: OUT, WALK_SENTENCE: SENTENCE, SERVER_LOG }))
  if (!v) throw new Error(`the chat-run driver needs ${n}`);
if (process.env.CINATRA_TEST_LLM_PROVIDER) { console.log("ABORT the scripted provider switch is set"); process.exit(1); }

const db = new Client({ connectionString: DB });
await db.connect();
const runsBefore = (await db.query("SELECT id FROM cinatra.agent_runs")).rows.map((r) => r.id);

const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: APP, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const signIn = await context.request.post("/api/auth/sign-in/email", { headers: { Origin: APP }, data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET } });
console.log(signIn.ok() ? "PASS signed in" : `FAIL sign-in ${signIn.status()}`);
if (!signIn.ok()) process.exit(1);
const page = await context.newPage();
page.setDefaultTimeout(600_000);
page.setDefaultNavigationTimeout(600_000);
const timeline = [];
const stamp = (what, extra = {}) => { const e = { at: new Date().toISOString(), what, ...extra }; timeline.push(e); console.log(`  · ${e.at} ${what}`); };

await page.goto("/chat", { waitUntil: "domcontentloaded" });
await page.waitForSelector('div[contenteditable="true"][role="textbox"]');

async function send(text) {
  await page.click('div[contenteditable="true"][role="textbox"]');
  await page.type('div[contenteditable="true"][role="textbox"]', text, { delay: 8 });
  await page.keyboard.press("Enter");
}
async function waitForAssistantTurn(before, maxTicks = 120) {
  for (let i = 0; i < maxTicks; i += 1) {
    const n = Number((await db.query("SELECT count(*) AS n FROM cinatra.assistant_turns WHERE role='assistant'")).rows[0].n);
    if (n > before) return true;
    await page.waitForTimeout(2000);
  }
  return false;
}

const warmBefore = Number((await db.query("SELECT count(*) AS n FROM cinatra.assistant_turns WHERE role='assistant'")).rows[0].n);
await send("Hello — are your platform tools available?");
await waitForAssistantTurn(warmBefore);
await page.waitForTimeout(12_000);
stamp("a warm-up turn was sent and answered before the measured turn");
const startOffset = (() => { try { return readFileSync(SERVER_LOG, "utf8").length; } catch { return 0; } })();

stamp("the person asked for the run in their own words", { sentence: SENTENCE });
const measuredBefore = Number((await db.query("SELECT count(*) AS n FROM cinatra.assistant_turns WHERE role='assistant'")).rows[0].n);
await send(SENTENCE);
await waitForAssistantTurn(measuredBefore);

// The run the app's own dispatch created, found BY DIFFERENCE.
let run = null;
for (let i = 0; i < 180; i += 1) {
  const rows = (await db.query(
    `SELECT id, status, created_at, started_at, template_id, a2a_task_id, lifecycle_moment, lifecycle_card_kind, lifecycle_card_ref, input_params
       FROM cinatra.agent_runs ORDER BY created_at DESC`)).rows;
  const fresh = rows.filter((r) => !runsBefore.includes(r.id));
  if (fresh.length > 0) { run = fresh[0]; if (run.status === "pending_approval") break; }
  await page.waitForTimeout(2000);
}
if (!run) { console.log("FAIL no run was created by the app's own dispatch"); await browser.close(); process.exit(1); }
stamp("the app's own dispatch created the run", { runId: run.id, status: run.status });

// Poll for the park at the HITL screen.
let parked = null;
for (let i = 0; i < 240; i += 1) {
  const r = (await db.query(
    `SELECT id, status, created_at, started_at, a2a_task_id, lifecycle_moment, lifecycle_card_kind, lifecycle_card_ref, input_params
       FROM cinatra.agent_runs WHERE id=$1`, [run.id])).rows[0];
  if (r.status === "pending_approval") { parked = r; break; }
  if (["failed", "completed", "cancelled"].includes(r.status)) { parked = r; break; }
  await page.waitForTimeout(2000);
}
stamp("the run reached its status", { runId: run.id, status: parked?.status ?? null, moment: parked?.lifecycle_moment ?? null });

const gate = (await db.query(
  `SELECT review_task_id, x_renderer, field_name, created_at FROM cinatra.agent_run_hitl_gate_artifacts WHERE run_id=$1 ORDER BY created_at DESC LIMIT 1`, [run.id])).rows[0] ?? null;
const threadUrl = page.url();
const out = {
  run: parked ?? run,
  gateRow: gate,
  threadUrl,
  sentence: SENTENCE,
  timeline,
  serverLogSlice: { startOffset, endOffset: (() => { try { return readFileSync(SERVER_LOG, "utf8").length; } catch { return 0; } })() },
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ runId: run.id, status: parked?.status, moment: parked?.lifecycle_moment, gate }, null, 2));
await db.end();
await browser.close();
