// THE RUN, STARTED FROM THE APP'S OWN CHAT, driven to the schedule moment.
//
// The person asks for the agent in their own words; the app's own dispatch
// creates the run; the setup gate is answered ON THE CARD, through the card's
// own Continue; then this driver WAITS — polling the run row and the stored
// transcript, sending no further message and asking for no "show me" tool —
// for the schedule card to arrive in the conversation from the run's own turn.
//
// NOTHING HERE IS INSERTED. No run, no gate, no park, no record, no review
// task, no status. The run is found BY DIFFERENCE against the rows that
// existed before, and every number is read back from the rows.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "@playwright/test";
import { Client } from "pg";

const APP = process.env.WALK_BASE;
const DB = process.env.SUPABASE_DB_URL;
const OUT = process.env.OUT_JSON;
const SENTENCE = process.env.WALK_SENTENCE;
const SERVER_LOG = process.env.SERVER_LOG;
const SETUP_ANSWER = process.env.WALK_ANSWER ?? "";
const WAIT_MS = Number(process.env.WALK_SCHEDULE_WAIT_MS ?? 300000);
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
const stamp = (what, extra = {}) => { const e = { at: new Date().toISOString(), what, ...extra }; timeline.push(e); console.log(`  · ${e.at} ${what}${Object.keys(extra).length ? " " + JSON.stringify(extra) : ""}`); };

await page.goto("/chat", { waitUntil: "domcontentloaded" });
await page.waitForSelector('div[contenteditable="true"][role="textbox"]');

async function send(text) {
  await page.click('div[contenteditable="true"][role="textbox"]');
  await page.type('div[contenteditable="true"][role="textbox"]', text, { delay: 8 });
  await page.keyboard.press("Enter");
}
const assistantTurns = async () =>
  Number((await db.query("SELECT count(*) AS n FROM cinatra.assistant_turns WHERE role='assistant'")).rows[0].n);
async function waitForAssistantTurn(before, maxTicks = 150) {
  for (let i = 0; i < maxTicks; i += 1) {
    if ((await assistantTurns()) > before) return true;
    await page.waitForTimeout(2000);
  }
  return false;
}

// A WARM-UP TURN, disclosed: the model's hosted MCP connector fails its first
// tool-list fetch on a cold ingress, and a refused turn is an environment fact,
// never a product reading.
// A refused turn is an INGRESS fact, never a product reading: the runtime HEADs
// the public MCP URL with a 2 500 ms budget and refuses the turn outright if it
// does not answer. So the probe turn is repeated until the platform's tools
// actually answer, and the refusals are counted rather than hidden.
let refusals = 0;
for (let attempt = 0; attempt < 6; attempt += 1) {
  const warmBefore = await assistantTurns();
  await send("Hello — are your platform tools available?");
  await waitForAssistantTurn(warmBefore);
  await page.waitForTimeout(8_000);
  const last = (await db.query(
    "SELECT content::text AS c FROM cinatra.assistant_turns WHERE role='assistant' ORDER BY created_at DESC LIMIT 1")).rows[0];
  const refused = /not reachable|tools are unavailable/i.test(String(last?.c ?? ""));
  if (!refused) { stamp("a warm-up (probe) turn was answered with the platform's tools available", { attempt, refusalsSoFar: refusals }); break; }
  refusals += 1;
  stamp("the ingress REFUSED the probe turn — an environment fact, not a product reading", { attempt });
  await page.waitForTimeout(10_000);
}
stamp("ingress refusals before the measured turn", { refusals });
const startOffset = (() => { try { return readFileSync(SERVER_LOG, "utf8").length; } catch { return 0; } })();

stamp("the person asked for the run in their own words", { sentence: SENTENCE });
const measuredBefore = await assistantTurns();
await send(SENTENCE);
await waitForAssistantTurn(measuredBefore);
const threadUrl = new URL(page.url()).pathname;
stamp("the dispatch turn settled in the conversation", { threadUrl });

let run = null;
for (let i = 0; i < 180; i += 1) {
  const rows = (await db.query(
    `SELECT id, status, created_at, started_at, template_id, lifecycle_moment, lifecycle_card_kind, lifecycle_card_ref
       FROM cinatra.agent_runs ORDER BY created_at DESC`)).rows;
  const fresh = rows.filter((r) => !runsBefore.includes(r.id));
  if (fresh.length > 0) { run = fresh[0]; break; }
  await page.waitForTimeout(2000);
}
if (!run) { console.log("FAIL no run was created by the app's own dispatch"); await browser.close(); process.exit(1); }
stamp("the app's own dispatch created the run", { runId: run.id, status: run.status });

const runRow = async () => (await db.query(
  `SELECT id, status, lifecycle_moment, lifecycle_card_kind, lifecycle_card_ref, updated_at
     FROM cinatra.agent_runs WHERE id=$1`, [run.id])).rows[0];

// The setup gate, answered ON THE CARD.
for (let i = 0; i < 240; i += 1) {
  const r = await runRow();
  if (r.status === "pending_approval") { stamp("the run parked", { status: r.status, moment: r.lifecycle_moment, kind: r.lifecycle_card_kind }); break; }
  if (["failed", "completed", "cancelled"].includes(r.status)) { stamp("the run reached a terminal status before any park", { status: r.status }); break; }
  await page.waitForTimeout(2000);
}
await page.waitForTimeout(4000);
const fields = page.locator('[data-conformance-id="hitl-screen-fields"]');
if ((await fields.count()) > 0) {
  const box = fields.locator("textarea, input[type='text'], input:not([type])").first();
  if (SETUP_ANSWER && (await box.count()) > 0) await box.fill(SETUP_ANSWER).catch(() => {});
  const cont = page.locator('[data-action="submit-hitl-screen"]').first();
  if ((await cont.count()) > 0) {
    await cont.scrollIntoViewIfNeeded().catch(() => {});
    await cont.click({ timeout: 120000 });
    stamp("the setup gate was answered through the card's own Continue");
  } else stamp("NO CONTINUE on the card — the setup gate submits on change");
} else stamp("NO HITL SCREEN CARD in the conversation at the park");

// THE WAIT. No further message, no "show me" tool: the transcript is polled for
// a schedule card the RUN'S OWN TURN carries.
const started = Date.now();
let arrived = null;
let lastRun = null;
while (Date.now() - started < WAIT_MS) {
  lastRun = await runRow();
  const parts = (await db.query(
    `SELECT id, role, created_at, content::text AS c FROM cinatra.assistant_turns ORDER BY created_at DESC LIMIT 30`)).rows;
  const hit = parts.find((p) => typeof p.c === "string" && p.c.includes("trigger_schedule_proposal"));
  const onScreen = await page.locator('[data-lifecycle-card="trigger_schedule_proposal"]').count();
  if (hit || onScreen > 0) {
    arrived = { at: new Date().toISOString(), msSinceSetupAnswer: Date.now() - started, inStoredTurn: Boolean(hit), turnId: hit?.id ?? null, turnRole: hit?.role ?? null, onScreenCount: onScreen };
    stamp("THE SCHEDULE CARD ARRIVED IN THE CONVERSATION", arrived);
    break;
  }
  await page.waitForTimeout(5000);
}
if (!arrived) stamp("THE SCHEDULE CARD DID NOT ARRIVE within the window", { windowMs: WAIT_MS, runStatus: lastRun?.status, moment: lastRun?.lifecycle_moment, kind: lastRun?.lifecycle_card_kind });

const gates = (await db.query(
  `SELECT review_task_id, x_renderer, field_name, created_at FROM cinatra.agent_run_hitl_gates WHERE run_id=$1 ORDER BY created_at`, [run.id])).rows;
const triggers = (await db.query(
  `SELECT count(*) AS n FROM information_schema.tables WHERE table_schema='cinatra' AND table_name='agent_run_triggers'`)).rows[0].n;
const tail = (() => { try { const s = readFileSync(SERVER_LOG, "utf8"); return s.slice(startOffset); } catch { return ""; } })();
const out = {
  runId: run.id,
  threadUrl,
  finalRun: lastRun ?? (await runRow()),
  scheduleCardArrived: arrived,
  gates,
  timeline,
  serverLogMarkers: {
    scriptedProviderLines: (tail.match(/CINATRA_TEST_LLM_PROVIDER|scripted-llm|ScriptedProvider/g) ?? []).length,
    llmBridgeRunSelect: (tail.match(/\[llm-bridge-run-select\]/g) ?? []).length,
    publicMcpCallbacks: (tail.match(/POST \/api\/mcp 200/g) ?? []).length,
    publicMcpRefusals: (tail.match(/public MCP|ingress refused|424/g) ?? []).length,
    probeRefusalsBeforeTheMeasuredTurn: refusals,
    outboxLines: (tail.match(/lifecycle-run-outbox|run-outbox/g) ?? []).length,
  },
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ runId: out.runId, threadUrl, arrived: Boolean(arrived), status: out.finalRun?.status, moment: out.finalRun?.lifecycle_moment, kind: out.finalRun?.lifecycle_card_kind }, null, 1));
await db.end();
await browser.close();
