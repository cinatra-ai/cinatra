// W5c picture leg — the RUN PAGE's three readings, in the order the recipe
// gives them: a described change lands in the fields and nothing is submitted;
// a question is answered and touches no field; a message that asks in so many
// words submits, and the fields still show what went.
//
// The driver presses NO screen button. The run's own Continue is never clicked
// here — where the run moves on, it is the assistant that pressed, on the
// person's explicit ask, through the screen's own server action.
//   env: APP_ORIGIN, OWNER_EMAIL, OWNER_PW, SUPABASE_DB_URL, CAPTURE_DIR, RUN_ID, RUN_PATH
import { openAs, readFields, readWindow, sendTurnWithColdStartRetry, shoot, stamp, db, runRow, write } from "./03-capture-lib.mjs";

const RUN_ID = process.env.RUN_ID;
const RUN_PATH = process.env.RUN_PATH;
const c = await db();
const record = { cell: "run-page", runId: RUN_ID, readings: [] };

const { browser, page } = await openAs(process.env.OWNER_EMAIL, process.env.OWNER_PW);
await page.goto(RUN_PATH, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(25_000);

async function reading(name, message, files) {
  const fieldsBefore = await readFields(page);
  const runBefore = await runRow(c, RUN_ID);
  const gateBefore = (await c.query(
    `select count(*)::int n from cinatra.agent_run_hitl_gates where run_id = $1`, [RUN_ID])).rows[0].n;
  const msgsBefore = (await c.query(
    `select count(*)::int n from cinatra.agent_run_messages where run_id = $1`, [RUN_ID])).rows[0].n;
  stamp(`--- ${name}: before`, { status: runBefore?.status, fields: fieldsBefore });
  const sent = await sendTurnWithColdStartRetry(page, message);
  await page.waitForTimeout(8000);
  const fieldsAfter = await readFields(page);
  const win = await readWindow(page);
  const runAfter = await runRow(c, RUN_ID);
  const gateAfter = (await c.query(
    `select count(*)::int n from cinatra.agent_run_hitl_gates where run_id = $1`, [RUN_ID])).rows[0].n;
  const msgsAfter = (await c.query(
    `select count(*)::int n from cinatra.agent_run_messages where run_id = $1`, [RUN_ID])).rows[0].n;
  const shots = files ? await shoot(page, files) : [];
  const r = {
    name, message,
    fieldsBefore, fieldsAfter,
    fieldsChanged: Object.keys(fieldsAfter).filter(
      (k) => (fieldsBefore[k]?.value ?? null) !== fieldsAfter[k].value),
    statusBefore: runBefore?.status ?? null,
    statusAfter: runAfter?.status ?? null,
    momentBefore: runBefore?.lifecycle_moment ?? null,
    momentAfter: runAfter?.lifecycle_moment ?? null,
    startedAtBefore: runBefore?.started_at ?? null,
    startedAtAfter: runAfter?.started_at ?? null,
    gateRowsBefore: gateBefore, gateRowsAfter: gateAfter,
    runMessagesBefore: msgsBefore, runMessagesAfter: msgsAfter,
    windowPlaceholder: win.placeholder,
    bubbles: win.bubbles,
    coldStartRetry: sent.retried,
    turnAttempts: sent.attempts,
    lastTurnServedWithoutToolbox: sent.servedWithoutToolbox,
    screenButtonPressedByTheAssistantDriver: false,
    shots: shots.map((s) => s.split("/").pop()),
  };
  record.readings.push(r);
  stamp(`--- ${name}: after`, {
    status: r.statusAfter, changed: r.fieldsChanged, gateRows: `${gateBefore}->${gateAfter}`,
  });
  return r;
}

// 1) THE FILL — the values land in the fields in view and nothing is submitted.
await reading(
  "fill-no-submit",
  'make the idea "A weekly publishing rhythm beats a burst of posts" and leave everything else as it is',
  "run-page__fill-no-submit",
);

// 2) THE NEGATIVE CONTROL — a question about the step is answered as a question
//    and touches no field.
await reading(
  "question-no-press",
  "what is this field for?",
  "run-page__question-no-press",
);

// 3) THE SUBMIT ON AN EXPLICIT ASK — the run moves on and the fields still show
//    what went.
await reading(
  "submit-on-ask",
  'set the idea to "Why cadence beats bursts for blog reach" and send it',
  "run-page__submit-on-ask",
);

record.windowRows = (await c.query(
  `select sequence, role, message_type, content, content_json::text, created_at
     from cinatra.agent_run_messages where run_id = $1 order by sequence`, [RUN_ID])).rows;
record.finalRun = await runRow(c, RUN_ID);
write("run-page-readback.json", record);
await c.end();
await browser.close();
console.log("DONE run-page cells");
