// W5c picture leg — ONE CELL, TAKEN IN THE CONTEXT THAT SENT THE TURN.
//
// WHY THIS FILE EXISTS. The graded leg took each pair in a FRESH context per
// theme, re-opening the run page and photographing it. That is correct for
// anything the RUN holds — the exchange is stored with the run, so a second
// context draws the same turns back. It is wrong for a fill: an unsubmitted
// fill is not part of the run, it is the values the turn placed in the fields
// of the page in front of the person, and `use-run-window-conversation.ts`
// applies exactly what the SEND returned and nothing on mount. So a fresh page
// load has nothing to apply, and the frames showed empty fields under a
// sentence that said they were filled.
//
// THE RULE HERE. The theme is chosen through the app's own control BEFORE the
// run page opens; the turn is sent in that same context; the field's value is
// read out of the DOM immediately before AND immediately after the shutter; and
// the frame is only filed when both reads agree. A cell whose turn cannot be
// sent twice therefore gets ONE RUN PER THEME.
//
//   env: APP_ORIGIN, OWNER_EMAIL, OWNER_PW, SUPABASE_DB_URL, CAPTURE_DIR,
//        SERVER_LOG, LANE_PUBLIC_ORIGIN, THEME, RUN_ID, RUN_PATH,
//        READINGS (json), READBACK_NAME
import fs from "node:fs";
import path from "node:path";
import {
  OUT_DIR, openAs, openPanel, readFields, readWindow, sendTurnWithColdStartRetry,
  stamp, db, runRow, waitForDrawnFrame, write,
} from "./03-capture-lib.mjs";

const THEME = process.env.THEME;
const RUN_ID = process.env.RUN_ID;
const RUN_PATH = process.env.RUN_PATH;
const READINGS = JSON.parse(process.env.READINGS);
if (!THEME || !RUN_ID || !RUN_PATH) throw new Error("18-cell-in-turn-context needs THEME, RUN_ID, RUN_PATH");

const c = await db();
const record = { theme: THEME, runId: RUN_ID, path: RUN_PATH, readings: [] };

const { browser, page } = await openAs(process.env.OWNER_EMAIL, process.env.OWNER_PW, { theme: THEME });
await page.goto(RUN_PATH, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(20_000);
// The account footer is the app shell's own loading state and it is simply
// waited out, IN THIS CONTEXT, before a single word is typed — so the person
// looking at the frame is drawn in it and the turn is still this context's.
const settledOnArrival = await waitForDrawnFrame(page);
stamp("the run page is drawn and the person is in the footer", {
  theme: THEME, footer: settledOnArrival.footer, waitedMs: settledOnArrival.waitedMs,
});

/** The theme as the DOCUMENT reports it, at the moment of the shutter. */
async function themeInView() {
  return page.evaluate(() => ({
    root: document.documentElement.className,
    dark: /\bdark\b/.test(document.documentElement.className),
  }));
}

/** A frame, with the DOM read on both sides of it so nothing moved across it. */
async function shootHere(name) {
  await openPanel(page);
  const settled = await waitForDrawnFrame(page, { tries: 30 });
  const before = await readFields(page);
  const themeAt = await themeInView();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${name}__${THEME}.png`);
  await page.screenshot({ path: file });
  const after = await readFields(page);
  const win = await readWindow(page);
  const values = (f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.value]));
  const agreed = JSON.stringify(values(before)) === JSON.stringify(values(after));
  stamp("capture recorded", {
    file: path.basename(file), theme: THEME, footer: settled.footer,
    fieldsAtShutter: values(after), domAgreedAcrossTheShutter: agreed,
  });
  return {
    file: path.basename(file),
    accountFooter: settled.footer,
    footerSettled: settled.settled,
    themeAtShutter: themeAt,
    fieldsJustBeforeTheShutter: values(before),
    fieldsJustAfterTheShutter: values(after),
    domAgreedAcrossTheShutter: agreed,
    windowPlaceholder: win.placeholder,
    bubbles: win.bubbles,
  };
}

for (const spec of READINGS) {
  const fieldsBefore = await readFields(page);
  const runBefore = await runRow(c, RUN_ID);
  const msgsBefore = (await c.query(
    `select count(*)::int n from cinatra.agent_run_messages where run_id = $1`, [RUN_ID])).rows[0].n;
  stamp(`--- ${spec.name}: before`, { theme: THEME, status: runBefore?.status, fields: fieldsBefore });

  // The paperclip, where the reading has one: the file is posted through the
  // window's own upload and the message is only sent once the app has answered.
  let attached = null;
  const attachNow = async () => {
    const input = page.locator('input[type="file"]').first();
    const uploaded = page.waitForResponse(
      (r) => r.url().includes("/api/artifacts/upload") && r.request().method() === "POST",
      { timeout: 300_000 },
    );
    await input.setInputFiles(spec.attach);
    const res = await uploaded;
    attached = spec.attach.split("/").pop();
    stamp("the window's own paperclip uploaded the file beside the message", {
      file: attached, status: res.status(),
    });
    await page.waitForTimeout(4000);
  };
  if (spec.attach) await attachNow();

  const sent = await sendTurnWithColdStartRetry(page, spec.message, {
    beforeEachAttempt: spec.attach ? async (n) => { if (n > 1) await attachNow(); } : undefined,
  });
  await page.waitForTimeout(8000);
  if (spec.expectResume) {
    for (let i = 0; i < 18; i += 1) {
      const now = await runRow(c, RUN_ID);
      const keys = Object.keys(await readFields(page)).join(",");
      if (now?.status !== runBefore?.status || keys !== Object.keys(fieldsBefore).join(",")) break;
      await page.waitForTimeout(5000);
    }
    await page.waitForTimeout(6000);
  }

  const frame = spec.capture ? await shootHere(spec.capture) : null;
  const runAfter = await runRow(c, RUN_ID);
  const rows = (await c.query(
    `select sequence, role, content, content_json::text as cj, created_at
       from cinatra.agent_run_messages where run_id = $1 order by sequence`, [RUN_ID])).rows;

  // THE DIAGNOSIS, on the reading that carries it: the SAME context reloads the
  // page and is read and photographed again. Nothing else changes — same
  // browser, same session, same theme, same run.
  let afterReload = null;
  if (spec.diagnose) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(22_000);
    const settled = await waitForDrawnFrame(page, { tries: 40 });
    await openPanel(page);
    const fields = await readFields(page);
    const file = path.join(OUT_DIR, `${spec.capture}__after-reload__${THEME}.png`);
    await page.screenshot({ path: file });
    afterReload = {
      file: path.basename(file),
      accountFooter: settled.footer,
      fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.value])),
      bubbles: (await readWindow(page)).bubbles.length,
    };
    stamp("--- diagnosis: the SAME context reloaded the page", afterReload);
  }

  const values = (f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.value]));
  const r = {
    name: spec.name, theme: THEME, message: spec.message, attached,
    fieldsBefore: values(fieldsBefore),
    fieldsChanged: Object.keys(frame?.fieldsJustAfterTheShutter ?? {})
      .filter((k) => (values(fieldsBefore)[k] ?? null) !== frame.fieldsJustAfterTheShutter[k])
      .map((k) => ({ field: k, from: values(fieldsBefore)[k] ?? null, to: frame.fieldsJustAfterTheShutter[k] })),
    statusBefore: runBefore?.status ?? null,
    statusAfter: runAfter?.status ?? null,
    runMessagesBefore: msgsBefore,
    runMessagesAfter: rows.length,
    newWindowRows: rows.slice(msgsBefore),
    turnAttempts: sent.attempts,
    lastTurnServedWithoutToolbox: sent.servedWithoutToolbox,
    screenButtonPressedByTheAssistantDriver: false,
    frame,
    afterReload,
  };
  record.readings.push(r);
  stamp(`--- ${spec.name}: after`, {
    theme: THEME, status: r.statusAfter, changed: r.fieldsChanged,
    domAgreedAcrossTheShutter: frame?.domAgreedAcrossTheShutter ?? null,
  });
}

record.finalRun = await runRow(c, RUN_ID);
write(process.env.READBACK_NAME, record);
await c.end();
await browser.close();
console.log(JSON.stringify(record.readings.map((r) => ({
  name: r.name, theme: r.theme, changed: r.fieldsChanged,
  fieldsAtShutter: r.frame?.fieldsJustAfterTheShutter,
  domAgreed: r.frame?.domAgreedAcrossTheShutter,
  footer: r.frame?.accountFooter,
  afterReload: r.afterReload?.fields ?? null,
})), null, 2));
