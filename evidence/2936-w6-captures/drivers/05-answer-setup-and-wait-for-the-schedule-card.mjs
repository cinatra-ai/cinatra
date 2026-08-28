// THE SETUP GATE, ANSWERED ON THE CARD — and then THE WAIT.
//
// After the card's own Continue is pressed, this driver sends NO further
// message and asks for no "show me" tool. It polls the run's own row and the
// STORED transcript for a schedule card the run's own turn carries, which is
// what plan (B) §6 asks for: "a run a person starts from a conversation reaches
// the schedule moment with its card in that conversation, never a silent wait".
//
// Whether the card arrives is the MEASUREMENT. Nothing is inserted.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "@playwright/test";
import { Client } from "pg";

const BASE = process.env.WALK_BASE, DB = process.env.SUPABASE_DB_URL;
const THREAD = process.env.WALK_THREAD_URL, RUN = process.env.WALK_RUN_ID, OUT = process.env.OUT_JSON;
const WAIT_MS = Number(process.env.WALK_SCHEDULE_WAIT_MS ?? 300000);
if (!BASE || !DB || !THREAD || !RUN || !OUT) throw new Error("needs WALK_BASE, SUPABASE_DB_URL, WALK_THREAD_URL, WALK_RUN_ID, OUT_JSON");
if (process.env.CINATRA_TEST_LLM_PROVIDER) { console.log("ABORT the scripted provider switch is set"); process.exit(1); }

const db = new Client({ connectionString: DB }); await db.connect();
const b = await chromium.launch();
const ctx = await b.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage(); page.setDefaultTimeout(300_000);
await page.request.post("/api/auth/sign-in/email", { headers: { Origin: BASE }, data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET } });
const timeline = [];
const stamp = (what, extra = {}) => { const e = { at: new Date().toISOString(), what, ...extra }; timeline.push(e); console.log(`  · ${e.at} ${what} ${Object.keys(extra).length ? JSON.stringify(extra) : ""}`); };
const runRow = async () => (await db.query(
  `select id,status,lifecycle_moment,lifecycle_card_kind,lifecycle_card_ref from cinatra.agent_runs where id=$1`, [RUN])).rows[0];

await page.goto(THREAD, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-lifecycle-card="agent_hitl_screen"]', { timeout: 300_000 });
await page.waitForTimeout(9000);
stamp("the setup screen is drawn in the conversation", await runRow());

const fields = page.locator('[data-conformance-id="hitl-screen-fields"]');
const boxes = fields.locator("textarea, input[type='text'], input:not([type])");
const nBoxes = await boxes.count();
stamp("the setup screen's own fields", { fieldRegions: await fields.count(), inputs: nBoxes });
if (process.env.WALK_ANSWER && nBoxes > 0) {
  await boxes.first().fill(process.env.WALK_ANSWER).catch(() => {});
  await page.waitForTimeout(2500);
}
const cont = page.locator('[data-action="submit-hitl-screen"]').first();
if ((await cont.count()) === 0) throw new Error("the setup card draws no Continue");
await cont.scrollIntoViewIfNeeded().catch(() => {});
const answeredAt = Date.now();
await cont.click();
stamp("the setup gate was answered through the CARD'S OWN Continue");

// THE WAIT — polled, with no message sent and no tool asked for.
let arrived = null, last = null;
while (Date.now() - answeredAt < WAIT_MS) {
  last = await runRow();
  const stored = (await db.query(
    `select id, role, created_at, content::text as c from cinatra.assistant_turns order by created_at desc limit 40`)).rows;
  const inTurn = stored.find((t) => typeof t.c === "string" && t.c.includes("trigger_schedule_proposal"));
  const onScreen = await page.locator('[data-lifecycle-card="trigger_schedule_proposal"]').count().catch(() => 0);
  if (inTurn || onScreen > 0) {
    arrived = { at: new Date().toISOString(), msAfterTheAnswer: Date.now() - answeredAt,
      carriedByAStoredTurn: Boolean(inTurn), turnId: inTurn?.id ?? null, turnRole: inTurn?.role ?? null,
      turnCreatedAt: inTurn?.created_at?.toISOString?.() ?? null, drawnOnScreen: onScreen,
      runAtThatMoment: last };
    stamp("THE SCHEDULE CARD ARRIVED IN THE CONVERSATION", arrived);
    break;
  }
  await page.waitForTimeout(5000);
}
if (!arrived) stamp("THE SCHEDULE CARD DID NOT ARRIVE within the window", { windowMs: WAIT_MS, run: last });
const out = { runId: RUN, threadUrl: THREAD, answeredAt: new Date(answeredAt).toISOString(),
  scheduleCardArrived: arrived, finalRun: await runRow(), timeline };
mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ arrived: Boolean(arrived), run: out.finalRun }, null, 1));
await db.end(); await b.close();
