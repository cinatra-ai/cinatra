// W5c picture leg — carry ONE run to a real review gate with the PERSON'S OWN
// presses. No assistant is involved here and nothing is written to the database
// by hand: the person types the setup field, presses the screen's own button,
// chooses "Run right after setup", and presses whatever the screen offers next
// until the run produces artifact-bound output and a review gate opens.
//   env: APP_ORIGIN, OWNER_EMAIL, OWNER_PW, SUPABASE_DB_URL, CAPTURE_DIR,
//        SERVER_LOG, LANE_PUBLIC_ORIGIN, AGENT_PATH, IDEA, OUT_NAME
import { openAs, readFields, stamp, db, runRow, write, waitForPublicOrigin } from "./03-capture-lib.mjs";

const c = await db();
const ingress = await waitForPublicOrigin();
stamp("ingress before the run is started", ingress);

const { browser, page } = await openAs(process.env.OWNER_EMAIL, process.env.OWNER_PW);
const seen = new Set();
for (const ev of ["request", "response"]) {
  page.on(ev, (r) => {
    const m = r.url().match(/\/api\/agents\/runs\/([0-9a-f-]{36})/);
    if (m) seen.add(m[1]);
  });
}
await page.goto(process.env.AGENT_PATH, { waitUntil: "domcontentloaded" });
for (let i = 0; i < 40 && seen.size === 0; i += 1) await page.waitForTimeout(4000);
await page.waitForTimeout(8000);
const RUN_ID = [...seen][0];
stamp("the run was created by the app", { runId: RUN_ID, url: page.url() });

const out = { runId: RUN_ID, presses: [], states: [] };

async function pressWhatTheScreenOffers(label) {
  const fields = await readFields(page);
  const buttons = await page.evaluate(() =>
    Array.from(document.querySelectorAll("button")).map((b) => (b.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean));
  out.presses.push({ at: new Date().toISOString(), label, fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.value])), buttons });
  stamp(`the screen offers`, { label, buttons: buttons.slice(0, 8) });
  const now = page.getByText("Run right after setup", { exact: false }).first();
  if (await now.count()) { await now.click(); stamp("the person chose 'Run right after setup'"); await page.waitForTimeout(2500); }
  const btn = page.getByRole("button", { name: /^(Continue|Save & start run|Start run|Submit)$/ }).first();
  if (await btn.count()) {
    await btn.click();
    stamp("the person pressed the screen's own button", { label });
    await page.waitForTimeout(9000);
    return true;
  }
  return false;
}

// 1) the setup gate — the person types the field and presses the button
const idea = process.env.IDEA ?? "Why a weekly publishing cadence beats a burst of posts";
const setupField = page.locator("#field-idea, textarea[name='field-idea'], textarea").first();
if (await setupField.count()) {
  await setupField.fill(idea);
  stamp("the person typed the setup field", { idea });
  await page.waitForTimeout(2000);
}
await pressWhatTheScreenOffers("setup gate");

// 2) whatever the run offers next, until a review gate exists or the run ends
for (let i = 0; i < 100; i += 1) {
  const row = await runRow(c, RUN_ID);
  const gates = (await c.query(
    `select review_task_id, status, created_at from cinatra.artifact_review_gates where run_id = $1 order by created_at`, [RUN_ID])).rows;
  const last = out.states[out.states.length - 1];
  const snap = { at: new Date().toISOString(), status: row?.status, moment: row?.lifecycle_moment, gates: gates.length };
  if (!last || last.status !== snap.status || last.gates !== snap.gates || last.moment !== snap.moment) {
    out.states.push(snap);
    stamp("run state", snap);
  }
  if (gates.length > 0) break;
  if (row?.status === "failed" || row?.status === "cancelled") break;
  if (row?.status === "pending_approval" || row?.status === "pending_trigger") {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(14_000);
    await pressWhatTheScreenOffers(`waiting screen ${i}`);
  } else {
    await page.waitForTimeout(10_000);
  }
}
out.finalRun = await runRow(c, RUN_ID);
out.reviewGates = (await c.query(
  `select review_task_id, status, created_at from cinatra.artifact_review_gates where run_id = $1`, [RUN_ID])).rows;
out.error = (await c.query(`select error from cinatra.agent_runs where id = $1`, [RUN_ID])).rows[0]?.error ?? null;
write(process.env.OUT_NAME ?? "drive-run-readback.json", out);
console.log(JSON.stringify({ runId: RUN_ID, status: out.finalRun?.status, gates: out.reviewGates.length, error: out.error }, null, 2));
await c.end();
await browser.close();
