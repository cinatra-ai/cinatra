// W5c picture leg — THE PERSON starts a run from the product's own agent page.
// Nothing is written to the database here: the app creates the run, and the run
// id is taken off the WIRE (the app's own /api/agents/runs/<uuid> call), never
// off a card's text.
//   env: APP_ORIGIN, OWNER_EMAIL, OWNER_PW, SUPABASE_DB_URL, CAPTURE_DIR, AGENT_PATH, OUT_NAME
import { openAs, stamp, db, runRow, write } from "./03-capture-lib.mjs";

const AGENT_PATH = process.env.AGENT_PATH;
const c = await db();
const { browser, page } = await openAs(process.env.OWNER_EMAIL, process.env.OWNER_PW);

const seen = new Set();
page.on("request", (r) => {
  const m = r.url().match(/\/api\/agents\/runs\/([0-9a-f-]{36})/);
  if (m) seen.add(m[1]);
});
page.on("response", (r) => {
  const m = r.url().match(/\/api\/agents\/runs\/([0-9a-f-]{36})/);
  if (m) seen.add(m[1]);
});

stamp("the person opened the agent's own start page", { path: AGENT_PATH });
await page.goto(AGENT_PATH, { waitUntil: "domcontentloaded" });
for (let i = 0; i < 60 && seen.size === 0; i += 1) await page.waitForTimeout(5000);
await page.waitForTimeout(8000);
const runId = [...seen][0] ?? null;
const url = page.url();
const row = runId ? await runRow(c, runId) : null;
const gates = runId
  ? (await c.query(
      `select review_task_id, field_name, created_at, input_schema::text as schema, gate_values::text as vals
         from cinatra.agent_run_hitl_gates where run_id = $1 order by created_at`, [runId])).rows
  : [];
const out = { agentPath: AGENT_PATH, runId, url, run: row, gates };
stamp("the run parked", { runId, status: row?.status, gates: gates.length });
write(process.env.OUT_NAME ?? "start-readback.json", out);
console.log(JSON.stringify({ runId, url, status: row?.status, gates: gates.length }, null, 2));
await c.end();
await browser.close();
