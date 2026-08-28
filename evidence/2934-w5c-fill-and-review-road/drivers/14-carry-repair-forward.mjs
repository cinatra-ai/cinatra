// W5c picture leg — THE REPAIR THAT WENT IN FLIGHT, CARRIED FORWARD BY THE
// PERSON. A changes-requested decision dispatches a repair; on this instance the
// repair run parks on the producer agent's own setup gate, so the person answers
// it with the screen's own control exactly as they answer any waiting screen.
// No assistant is involved here and no row is written by hand.
//   env: APP_ORIGIN, OWNER_EMAIL, OWNER_PW, SUPABASE_DB_URL, CAPTURE_DIR,
//        SERVER_LOG, LANE_PUBLIC_ORIGIN, REPAIR_RUN_ID, BASE_RUN_ID, VENDOR_PATH,
//        IDEA
import { openAs, readFields, shoot, stamp, db, runRow, write } from "./03-capture-lib.mjs";

const REPAIR = process.env.REPAIR_RUN_ID;
const BASE = process.env.BASE_RUN_ID;
const c = await db();
const out = { repairRunId: REPAIR, baseRunId: BASE, presses: [], states: [] };

const gates = async () => (await c.query(
  `select id, review_task_id, status, disposition, created_at from cinatra.artifact_review_gates
     where run_id = $1 order by created_at`, [BASE])).rows;
const repairs = async () => (await c.query(
  `select id, status, attempt, successor_gate_id, findings::text as findings from cinatra.lifecycle_repair
     where producer_run_id = $1 order by created_at`, [BASE])).rows;

const { browser, page } = await openAs(process.env.OWNER_EMAIL, process.env.OWNER_PW);
const path = `${process.env.VENDOR_PATH}/${encodeURIComponent(REPAIR)}`;
await page.goto(path, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(28_000);
stamp("the person opened the repair run", { path, url: page.url() });

for (let i = 0; i < 40; i += 1) {
  const row = await runRow(c, REPAIR);
  const g = await gates();
  const snap = { at: new Date().toISOString(), repairRunStatus: row?.status, baseGates: g.length, repairs: (await repairs()).map((r) => r.status) };
  const last = out.states[out.states.length - 1];
  if (!last || JSON.stringify(last).slice(20) !== JSON.stringify(snap).slice(20)) { out.states.push(snap); stamp("state", snap); }
  if (g.length > 1) break;
  if (row?.status === "pending_approval" || row?.status === "pending_trigger") {
    const field = page.locator("#field-idea, textarea").first();
    if (await field.count()) {
      const v = await field.inputValue().catch(() => "");
      if (!v) { await field.fill(process.env.IDEA ?? "Why a weekly publishing cadence beats a burst of posts"); await page.waitForTimeout(1500); }
    }
    const now = page.getByText("Run right after setup", { exact: false }).first();
    if (await now.count()) { await now.click(); await page.waitForTimeout(2000); }
    const btn = page.getByRole("button", { name: /^(Continue|Save & start run|Start run)$/ }).first();
    if (await btn.count()) {
      out.presses.push({ at: new Date().toISOString(), fields: Object.fromEntries(Object.entries(await readFields(page)).map(([k, v]) => [k, v.value])) });
      await btn.click();
      stamp("the person pressed the repair run's own button");
      await page.waitForTimeout(12_000);
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(14_000);
  } else {
    await page.waitForTimeout(12_000);
  }
}

out.finalRepairRun = await runRow(c, REPAIR);
out.baseGates = await gates();
out.repairs = await repairs();
const fresh = out.baseGates.filter((g) => g.status === "pending").slice(-1)[0] ?? null;
out.freshGate = fresh;
if (fresh) {
  const p2 = `${process.env.VENDOR_PATH}/${BASE}/review/${encodeURIComponent(fresh.review_task_id)}`;
  stamp("the corrected version returned as a fresh review beneath the resolved one", { gate: fresh.id, path: p2 });
  await page.goto(p2, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(32_000);
  out.freshReading = {
    rail: await page.evaluate(() => Array.from(document.querySelectorAll("button, a")).map((b) => (b.textContent || "").replace(/\s+/g, " ").trim()).filter((t) => /^\d+(Schedule|Review|Step)/.test(t))),
    decisionBar: await page.evaluate(() => Array.from(document.querySelectorAll("button")).map((b) => (b.textContent || "").replace(/\s+/g, " ").trim()).filter((t) => /^(Approve|Reject|Comment)$/.test(t))),
    shots: (await shoot(page, "review__request-changes-fresh-review")).map((s) => s.split("/").pop()),
  };
}
write("repair-forward-readback.json", out);
console.log(JSON.stringify({ repairRun: out.finalRepairRun?.status, gates: out.baseGates.map((g) => `${g.status}/${g.disposition ?? "-"}`), fresh: Boolean(fresh) }, null, 2));
await c.end();
await browser.close();
