// W5c picture leg — the STEP-BY-STEP screen: a half-typed message surviving a
// reload, a described change landing in the step's own fields with nothing
// submitted, and a file attached beside a message reaching the waiting run.
//   env: APP_ORIGIN, OWNER_EMAIL, OWNER_PW, SUPABASE_DB_URL, CAPTURE_DIR,
//        SERVER_LOG, RUN_ID, RUN_PATH, ATTACH_FILE
import fs from "node:fs";
import {
  openAs, readFields, readWindow, sendTurnWithColdStartRetry, shoot, stamp, db, runRow, write,
} from "./03-capture-lib.mjs";

const RUN_ID = process.env.RUN_ID;
const RUN_PATH = process.env.RUN_PATH;
const c = await db();
const record = { cell: "step-by-step", runId: RUN_ID, readings: [] };

const { browser, page } = await openAs(process.env.OWNER_EMAIL, process.env.OWNER_PW);
await page.goto(RUN_PATH, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(25_000);
const PROMPT = 'div[contenteditable="true"][role="textbox"]';

// ── 1) THE DRAFT. Half a sentence, a real browser reload, and the half sentence
//       still in the field. Nothing is sent.
const HALF = "please set the call to action to";
if (!process.env.ONLY_READING) {
await page.click(PROMPT);
await page.type(PROMPT, HALF, { delay: 8 });
await page.waitForTimeout(2500);
const draftBefore = (await readWindow(page)).draft;
const storedBefore = await page.evaluate(() => {
  const out = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i);
    if (k && k.includes("hitl")) out[k] = localStorage.getItem(k);
  }
  return out;
});
stamp("half a sentence typed into the window, nothing sent", { draftBefore, storedBefore });
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(22_000);
const draftAfter = (await readWindow(page)).draft;
const shotsDraft = await shoot(page, "step-by-step__draft-survives-reload");
record.readings.push({
  name: "draft-survives-reload",
  typed: HALF, draftBefore, draftAfter,
  survived: (draftAfter ?? "").includes(HALF),
  storedKeys: Object.keys(storedBefore),
  shots: shotsDraft.map((s) => s.split("/").pop()),
});
stamp("--- draft-survives-reload", { draftAfter, survived: (draftAfter ?? "").includes(HALF) });

// clear the half sentence so it does not travel with the next message
await page.click(PROMPT);
await page.keyboard.press("Control+A");
await page.keyboard.press("Meta+A");
await page.keyboard.press("Backspace");
await page.waitForTimeout(1500);
}

async function reading(name, message, files, { attach } = {}) {
  const fieldsBefore = await readFields(page);
  const runBefore = await runRow(c, RUN_ID);
  const msgsBefore = (await c.query(
    `select count(*)::int n from cinatra.agent_run_messages where run_id = $1`, [RUN_ID])).rows[0].n;
  stamp(`--- ${name}: before`, { status: runBefore?.status, fields: fieldsBefore });
  let attached = null;
  const attachNow = async () => {
    // WAIT FOR THE UPLOAD, NOT FOR A CLOCK. The window's paperclip posts the
    // file to the app's own artifact upload and only then holds a ref for the
    // next message; a fixed sleep sent the message before the ref existed and
    // measured the driver, not the road.
    const input = page.locator('input[type="file"]').first();
    const uploaded = page.waitForResponse(
      (r) => r.url().includes("/api/artifacts/upload") && r.request().method() === "POST",
      { timeout: 300_000 },
    );
    await input.setInputFiles(attach);
    const res = await uploaded;
    attached = attach.split("/").pop();
    stamp("the window's own paperclip uploaded the file beside the message", {
      file: attached, status: res.status(),
    });
    await page.waitForTimeout(4000);
  };
  if (attach) await attachNow();
  const sent = await sendTurnWithColdStartRetry(page, message, {
    beforeEachAttempt: attach ? async (n) => { if (n > 1) await attachNow(); } : undefined,
  });
  await page.waitForTimeout(8000);
  const fieldsAfter = await readFields(page);
  const win = await readWindow(page);
  const runAfter = await runRow(c, RUN_ID);
  const rows = (await c.query(
    `select sequence, role, content, content_json::text as cj, created_at
       from cinatra.agent_run_messages where run_id = $1 order by sequence`, [RUN_ID])).rows;
  const shots = files ? await shoot(page, files) : [];
  const r = {
    name, message, attached,
    fieldsBefore, fieldsAfter,
    fieldsChanged: Object.keys(fieldsAfter).filter(
      (k) => (fieldsBefore[k]?.value ?? null) !== fieldsAfter[k].value),
    statusBefore: runBefore?.status ?? null,
    statusAfter: runAfter?.status ?? null,
    runMessagesBefore: msgsBefore, runMessagesAfter: rows.length,
    windowPlaceholder: win.placeholder,
    bubbles: win.bubbles,
    newWindowRows: rows.slice(msgsBefore),
    turnAttempts: sent.attempts,
    screenButtonPressedByTheAssistantDriver: false,
    shots: shots.map((s) => s.split("/").pop()),
  };
  record.readings.push(r);
  stamp(`--- ${name}: after`, { status: r.statusAfter, changed: r.fieldsChanged });
  return r;
}

const ONLY = process.env.ONLY_READING ?? "";

// ── 2) THE FILL on one step of a multi-step run.
if (!ONLY || ONLY === "fill") await reading(
  "fill-no-submit",
  'set the offering company website to "https://example.test" and the call to action to "Book a 20-minute demo", and leave the sender name as it is',
  "step-by-step__fill-no-submit",
);

// ── 3) THE ATTACHMENT beside a message that also asks for the send.
if ((!ONLY || ONLY === "attach") && process.env.ATTACH_FILE && fs.existsSync(process.env.ATTACH_FILE)) {
  await reading(
    "attachment-reaches-run",
    process.env.ATTACH_MESSAGE ||
      "fill the brief from the file I attached and send it",
    "step-by-step__attachment-reaches-run",
    { attach: process.env.ATTACH_FILE },
  );
}

record.finalRun = await runRow(c, RUN_ID);
record.allWindowRows = (await c.query(
  `select sequence, role, content, content_json::text as cj, created_at
     from cinatra.agent_run_messages where run_id = $1 order by sequence`, [RUN_ID])).rows;
write(process.env.READBACK_NAME || "step-by-step-readback.json", record);
await c.end();
await browser.close();
console.log("DONE step-by-step cells");
