// W5c picture leg — one surface, a list of typed messages, graded the same way
// everywhere: the fields in view before and after, the run row before and after,
// the window's own rows, and a full-window picture in both themes.
//
// It presses NO screen button.
//   env: APP_ORIGIN, OWNER_EMAIL, OWNER_PW, SUPABASE_DB_URL, CAPTURE_DIR,
//        SERVER_LOG, RUN_ID, RUN_PATH, READINGS (json), READBACK_NAME
import {
  openAs, readFields, readWindow, sendTurnWithColdStartRetry, shoot, stamp, db, runRow, write,
} from "./03-capture-lib.mjs";

const RUN_ID = process.env.RUN_ID;
const RUN_PATH = process.env.RUN_PATH;
const READINGS = JSON.parse(process.env.READINGS);
const c = await db();
const record = { runId: RUN_ID, path: RUN_PATH, readings: [] };

const { browser, page } = await openAs(process.env.OWNER_EMAIL, process.env.OWNER_PW);
await page.goto(RUN_PATH, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(28_000);

for (const spec of READINGS) {
  const fieldsBefore = await readFields(page);
  const runBefore = await runRow(c, RUN_ID);
  const msgsBefore = (await c.query(
    `select count(*)::int n from cinatra.agent_run_messages where run_id = $1`, [RUN_ID])).rows[0].n;
  stamp(`--- ${spec.name}: before`, { status: runBefore?.status, fields: fieldsBefore });
  const sent = await sendTurnWithColdStartRetry(page, spec.message);
  await page.waitForTimeout(8000);
  // Where the message may have PRESSED, the card is the visible truth only once
  // it has re-read itself. Wait for the run row to move and then for the screen
  // to redraw, up to 90 s, so the frame is the card's settled reading and not
  // its loading one.
  if (spec.expectResume) {
    for (let i = 0; i < 18; i += 1) {
      const now = await runRow(c, RUN_ID);
      const keys = Object.keys(await readFields(page)).join(",");
      if (now?.status !== runBefore?.status && keys !== Object.keys(fieldsBefore).join(",")) break;
      await page.waitForTimeout(5000);
    }
    await page.waitForTimeout(4000);
  }
  const fieldsAfter = await readFields(page);
  const win = await readWindow(page);
  const runAfter = await runRow(c, RUN_ID);
  const rows = (await c.query(
    `select sequence, role, content, content_json::text as cj, created_at
       from cinatra.agent_run_messages where run_id = $1 order by sequence`, [RUN_ID])).rows;
  const shots = spec.capture ? await shoot(page, spec.capture) : [];
  const r = {
    name: spec.name, message: spec.message,
    fieldsBefore, fieldsAfter,
    fieldsChanged: Object.keys(fieldsAfter).filter(
      (k) => (fieldsBefore[k]?.value ?? null) !== fieldsAfter[k].value)
      .map((k) => ({ field: k, from: fieldsBefore[k]?.value ?? null, to: fieldsAfter[k].value })),
    statusBefore: runBefore?.status ?? null,
    statusAfter: runAfter?.status ?? null,
    windowPlaceholder: win.placeholder,
    bubbles: win.bubbles,
    newWindowRows: rows.slice(msgsBefore),
    turnAttempts: sent.attempts,
    screenButtonPressedByTheAssistantDriver: false,
    shots: shots.map((s) => s.split("/").pop()),
  };
  record.readings.push(r);
  stamp(`--- ${spec.name}: after`, { status: r.statusAfter, changed: r.fieldsChanged });
}

record.finalRun = await runRow(c, RUN_ID);
write(process.env.READBACK_NAME, record);
await c.end();
await browser.close();
console.log("DONE surface cells");
