// Advance a run whose idea is already set, with the PERSON'S OWN presses on the
// screens the run offers, until a review gate opens.
import { openAs, stamp, db, runRow, write } from "./03-capture-lib.mjs";
const RUN_ID = process.env.RUN_ID;
const RUN_PATH = process.env.RUN_PATH;
const c = await db();
const { browser, page } = await openAs(process.env.OWNER_EMAIL, process.env.OWNER_PW);
page.setDefaultTimeout(300000);
const gates = async () => (await c.query(
  `select id, review_task_id, status from cinatra.artifact_review_gates where run_id = $1 order by created_at`, [RUN_ID])).rows;
const out = { runId: RUN_ID, presses: [], states: [] };
for (let round = 0; round < 14; round += 1) {
  await page.goto(RUN_PATH, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(22000);
  const g = await gates();
  const row = await runRow(c, RUN_ID);
  out.states.push({ at: new Date().toISOString(), round, status: row?.status, gates: g.length });
  stamp("run state", { round, status: row?.status, gates: g.length });
  if (g.some((x) => x.status === "pending")) { out.reviewGate = g.find((x) => x.status === "pending"); break; }
  if (row?.status === "failed") break;
  const now = page.getByText("Run right after setup", { exact: false }).first();
  if (await now.count()) { await now.click(); await page.waitForTimeout(2500); }
  const btn = page.getByRole("button", { name: /^(Continue|Save & start run|Start run|Submit)$/ }).first();
  if (await btn.count()) {
    const label = await btn.textContent();
    await btn.click();
    out.presses.push({ at: new Date().toISOString(), round, label: (label||"").trim() });
    stamp("the person pressed the screen's own button", { round, label: (label||"").trim() });
    await page.waitForTimeout(30000);
  } else {
    await page.waitForTimeout(30000);
  }
}
out.finalRun = await runRow(c, RUN_ID);
out.finalGates = await gates();
write(process.env.OUT_NAME ?? "advance-readback.json", out);
console.log(JSON.stringify({ runId: RUN_ID, status: out.finalRun?.status, gates: out.finalGates.map(x=>x.status), reviewTaskId: out.reviewGate?.review_task_id ?? null }, null, 1));
await c.end(); await browser.close();
