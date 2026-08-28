// W5c picture leg — WHERE THE STEP-BY-STEP SCREEN GOES AFTER THE SUBMIT, and
// what a SECOND context sees at that address.
//
// The graded review found one frame showing the platform s "Not authorized"
// page. That frame was taken by re-opening `page.url()` in a FRESH context
// after the message had asked for the submit, so this measures exactly that:
// the address the driving context is standing on once the turn comes back, what
// the driving context itself draws there, and what a second context — same
// person, same password, new session — draws at the same address.
//   env: APP_ORIGIN, OWNER_EMAIL, OWNER_PW, CAPTURE_DIR, SERVER_LOG,
//        LANE_PUBLIC_ORIGIN, RUN_ID, RUN_PATH, ATTACH_FILE, MESSAGE
import { openAs, readFields, readWindow, sendTurnWithColdStartRetry, stamp, db, runRow, waitForDrawnFrame, write } from "./03-capture-lib.mjs";

const RUN_ID = process.env.RUN_ID;
const RUN_PATH = process.env.RUN_PATH;
const c = await db();
const record = { runId: RUN_ID, path: RUN_PATH };

const { browser, page } = await openAs(process.env.OWNER_EMAIL, process.env.OWNER_PW, { theme: "light" });
await page.goto(RUN_PATH, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(20000);
await waitForDrawnFrame(page);
record.before = { url: page.url(), fields: Object.keys(await readFields(page)), status: (await runRow(c, RUN_ID))?.status ?? null };

if (process.env.ATTACH_FILE) {
  const input = page.locator("input[type=file]").first();
  const uploaded = page.waitForResponse((r) => r.url().includes("/api/artifacts/upload") && r.request().method() === "POST", { timeout: 300000 });
  await input.setInputFiles(process.env.ATTACH_FILE);
  const res = await uploaded;
  stamp("the window s own paperclip uploaded the file beside the message", { status: res.status() });
}
await sendTurnWithColdStartRetry(page, process.env.MESSAGE);
await page.waitForTimeout(15000);
for (let i = 0; i < 12; i += 1) {
  const now = await runRow(c, RUN_ID);
  if (now?.status !== record.before.status) break;
  await page.waitForTimeout(5000);
}
await page.waitForTimeout(8000);

const bodyOf = async (p) => (await p.evaluate(() => document.body.innerText.replace(/\s+/g, " "))).slice(0, 400);
record.afterInTheDrivingContext = {
  url: page.url(),
  fields: Object.keys(await readFields(page)),
  bubbles: (await readWindow(page)).bubbles.length,
  body: await bodyOf(page),
  status: (await runRow(c, RUN_ID))?.status ?? null,
};
stamp("--- the driving context, after the submit", record.afterInTheDrivingContext);

// THE SECOND CONTEXT, which is what the graded leg photographed.
const second = await openAs(process.env.OWNER_EMAIL, process.env.OWNER_PW, { theme: "light" });
const res = await second.page.goto(record.afterInTheDrivingContext.url, { waitUntil: "domcontentloaded" });
await second.page.waitForTimeout(20000);
record.afterInASecondContext = {
  url: second.page.url(),
  httpStatus: res?.status() ?? null,
  fields: Object.keys(await readFields(second.page)),
  bubbles: (await readWindow(second.page)).bubbles.length,
  body: await bodyOf(second.page),
};
stamp("--- a second context at the same address", record.afterInASecondContext);
await second.browser.close();

record.finalRun = await runRow(c, RUN_ID);
record.windowRows = (await c.query(
  `select sequence, role, content, content_json::text as cj from cinatra.agent_run_messages where run_id = $1 order by sequence`, [RUN_ID])).rows;
write(process.env.READBACK_NAME || "after-submit-route-probe.json", record);
await c.end();
await browser.close();
console.log(JSON.stringify({ before: record.before, driving: record.afterInTheDrivingContext, second: record.afterInASecondContext }, null, 2));
