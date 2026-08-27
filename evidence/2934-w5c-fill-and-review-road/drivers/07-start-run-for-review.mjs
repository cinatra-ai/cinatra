// W5c picture leg — THE PERSON starts the run with the screen's own controls, so
// a real review gate exists to photograph. Every click here is the person's own:
// the scheduler's "Run right after setup" and the screen's own button. No
// assistant is involved and nothing is written to the store by hand.
//   env: APP_ORIGIN, OWNER_EMAIL, OWNER_PW, SUPABASE_DB_URL, CAPTURE_DIR, RUN_ID, RUN_PATH
import { openAs, stamp, db, runRow, write } from "./03-capture-lib.mjs";

const RUN_ID = process.env.RUN_ID;
const c = await db();
const { browser, page } = await openAs(process.env.OWNER_EMAIL, process.env.OWNER_PW);
await page.goto(process.env.RUN_PATH, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(25_000);

const now = page.getByText("Run right after setup", { exact: false }).first();
if (await now.count()) {
  await now.click();
  stamp("the person chose 'Run right after setup' on the scheduler form");
  await page.waitForTimeout(3000);
}
const btn = page.getByRole("button", { name: /^(Continue|Save & start run|Start run)$/ }).first();
if (await btn.count()) {
  await btn.click();
  stamp("the person pressed the screen's own button");
} else {
  stamp("the screen offered no start button", { buttons: await page.evaluate(() => Array.from(document.querySelectorAll("button")).map((b) => b.textContent.trim()).filter(Boolean)) });
}

const out = { runId: RUN_ID, states: [] };
for (let i = 0; i < 90; i += 1) {
  const row = await runRow(c, RUN_ID);
  const gates = (await c.query(
    `select id, status, review_task_id, created_at from cinatra.artifact_review_gates
       where run_id = $1 order by created_at`, [RUN_ID])).rows;
  const last = out.states[out.states.length - 1];
  const now2 = { at: new Date().toISOString(), status: row?.status, gates: gates.length };
  if (!last || last.status !== now2.status || last.gates !== now2.gates) {
    out.states.push(now2);
    stamp("run state", now2);
  }
  if (gates.length > 0) break;
  await page.waitForTimeout(10_000);
}
out.finalRun = await runRow(c, RUN_ID);
out.reviewGates = (await c.query(`select * from cinatra.artifact_review_gates where run_id = $1`, [RUN_ID])).rows;
write("start-run-readback.json", out);
await c.end();
await browser.close();
console.log(JSON.stringify({ status: out.finalRun?.status, gates: out.reviewGates.length }, null, 2));
