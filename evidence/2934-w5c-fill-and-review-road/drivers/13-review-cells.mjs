// W5c picture leg — THE REVIEW PAGE'S TWO READINGS.
//   (4) a typed QUESTION is answered and files nothing: the gate stays pending,
//       the decision bar is untouched, and no disposition or repair row exists.
//   (5) a typed REQUEST FOR CHANGES is filed through the card's own Comment
//       control, word for word: the gate resolves changes-requested, a repair
//       goes in flight carrying the person's own words, and the corrected
//       version returns as a fresh review gate beneath the resolved one.
// The driver presses NO decision button: Approve, Reject and Comment are never
// clicked here. The only clicks are the window's field and the theme control.
//   env: APP_ORIGIN, OWNER_EMAIL, OWNER_PW, SUPABASE_DB_URL, CAPTURE_DIR,
//        SERVER_LOG, LANE_PUBLIC_ORIGIN, RUN_ID, REVIEW_PATH, VENDOR_PATH
import { openAs, readWindow, sendTurnWithColdStartRetry, shoot, stamp, db, runRow, write } from "./03-capture-lib.mjs";

const RUN_ID = process.env.RUN_ID;
const c = await db();
const record = { cell: "review-page", runId: RUN_ID, reviewPath: process.env.REVIEW_PATH, only: process.env.ONLY_READING ?? null, readings: [] };

const gateRows = async () => (await c.query(
  `select id, review_task_id, status, disposition, resolved_by, resolved_at, created_at
     from cinatra.artifact_review_gates where run_id = $1 order by created_at`, [RUN_ID])).rows;
const dispositionRows = async () => (await c.query(
  `select id, gate_id, kind, created_at from cinatra.artifact_review_dispositions where run_id = $1 order by created_at`, [RUN_ID])).rows;
const repairRows = async () => (await c.query(
  `select id, producer_run_id, gate_id, status, attempt, successor_gate_id, findings::text as findings, created_at
     from cinatra.lifecycle_repair where producer_run_id = $1 order by created_at`, [RUN_ID])).rows;
const decisionBar = async (page) => page.evaluate(() =>
  Array.from(document.querySelectorAll("button")).map((b) => (b.textContent || "").replace(/\s+/g, " ").trim())
    .filter((t) => /^(Approve|Reject|Comment)$/.test(t)));
const rail = async (page) => page.evaluate(() =>
  Array.from(document.querySelectorAll("button, a")).map((b) => (b.textContent || "").replace(/\s+/g, " ").trim())
    .filter((t) => /^\d+(Schedule|Review|Step)/.test(t)));
const rationale = async (page) => page.evaluate(() => document.querySelector("#review-rationale")?.value ?? null);

const { browser, page } = await openAs(process.env.OWNER_EMAIL, process.env.OWNER_PW);
await page.goto(process.env.REVIEW_PATH, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(35_000);

async function reading(name, message, capture) {
  const before = {
    gates: await gateRows(), dispositions: await dispositionRows(), repairs: await repairRows(),
    run: await runRow(c, RUN_ID), decisionBar: await decisionBar(page), rail: await rail(page),
    rationale: await rationale(page),
  };
  stamp(`--- ${name}: before`, { gates: before.gates.map((g) => g.status), bar: before.decisionBar, rail: before.rail });
  const sent = await sendTurnWithColdStartRetry(page, message);
  await page.waitForTimeout(10_000);
  // A filed request resolves the gate and sends a repair; the card is the visible
  // truth only once it has re-read itself, so the frame waits for the row to move.
  if (name === "request-changes") {
    for (let i = 0; i < 30; i += 1) {
      const g = await gateRows();
      if (g.some((x) => x.status !== "pending")) break;
      await page.waitForTimeout(5000);
    }
    await page.waitForTimeout(8000);
  }
  const after = {
    gates: await gateRows(), dispositions: await dispositionRows(), repairs: await repairRows(),
    run: await runRow(c, RUN_ID), decisionBar: await decisionBar(page), rail: await rail(page),
    rationale: await rationale(page),
  };
  const shots = capture ? await shoot(page, capture) : [];
  const r = {
    name, message, before, after,
    bubbles: (await readWindow(page)).bubbles,
    turnAttempts: sent.attempts,
    decisionButtonPressedByTheDriver: false,
    shots: shots.map((s) => s.split("/").pop()),
  };
  record.readings.push(r);
  stamp(`--- ${name}: after`, {
    gates: after.gates.map((g) => `${g.status}/${g.disposition ?? "-"}`),
    dispositions: after.dispositions.length, repairs: after.repairs.length, rail: after.rail,
  });
  return r;
}

// EACH READING CAN BE RUN ON ITS OWN. The two readings share one gate and the
// second RESOLVES it, so a frame of the first has to be taken while the first is
// still the newest turn in the window. `ONLY_READING` lets the question be
// driven, photographed and measured before the change request is typed.
const ONLY = process.env.ONLY_READING ?? "";
if (!ONLY || ONLY === "question") {
  await reading("question", "what changed in this draft?", "review__question");
}
if (!ONLY || ONLY === "request-changes") {
  await reading("request-changes", "tighten the opening paragraph", "review__request-changes");
}

// The fresh review beneath the resolved one: wait for the repair to return.
let fresh = null;
for (let i = 0; ONLY !== "question" && i < 40; i += 1) {
  const g = await gateRows();
  const pending = g.filter((x) => x.status === "pending");
  if (g.length > record.readings[record.readings.length - 1].before.gates.length && pending.length > 0) { fresh = pending[pending.length - 1]; break; }
  await page.waitForTimeout(15_000);
}
record.freshGate = fresh;
if (fresh) {
  const path = `${process.env.VENDOR_PATH}/${RUN_ID}/review/${encodeURIComponent(fresh.review_task_id)}`;
  stamp("the corrected version returned as a fresh review", { gate: fresh.id, path });
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(30_000);
  record.freshReading = {
    gates: await gateRows(), decisionBar: await decisionBar(page), rail: await rail(page),
    shots: (await shoot(page, "review__request-changes-fresh-review")).map((s) => s.split("/").pop()),
  };
} else {
  stamp("no fresh review gate returned within the wait");
}
record.finalGates = await gateRows();
record.finalRepairs = await repairRows();
record.finalDispositions = await dispositionRows();
record.finalRun = await runRow(c, RUN_ID);
write(process.env.READBACK_NAME ?? "review-readback.json", record);
console.log(JSON.stringify({ gates: record.finalGates.map((g) => `${g.status}/${g.disposition ?? "-"}`), repairs: record.finalRepairs.length, fresh: Boolean(fresh) }, null, 2));
await c.end();
await browser.close();
