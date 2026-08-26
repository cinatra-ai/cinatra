// DRIVE A RUN TO ITS REVIEW GATE, AND SHOOT THE READING THAT ONLY EXISTS ON THE
// WAY THERE (cinatra#2970, PR #2975 round 8).
//
// `runReviewStepReading` answers `working` while the run has a PENDING
// artifact-produced outbox row and no gate yet, and `review` once the sweeper has
// opened a gate from that row. The first of those readings lives only inside that
// window, so it cannot be photographed by opening the page after the run is over:
// this driver watches the run's OWN rows four times a second and fires the capture
// the instant the window opens.
//
// It also answers the run's mid-run approval steps, because a run that is never
// answered never produces an artifact. Each press runs in its own short-lived
// process with a SHORT budget (`2975-r8-press-approval.mjs`), so a slow page can
// never block the watcher across the window; a run that comes back to
// `pending_approval` is answered again after a cool-down rather than once and for
// all, which is what the round 7 catcher could not do.
//
// NOTHING HERE WRITES TO THE DATABASE. Every status, outbox row and gate it
// reports is the app's own, read back.
//
//   env: WALK_BASE, LANE_ACCOUNT, LANE_SECRET, SUPABASE_DB_URL, WALK_RUN_ID,
//        RUN_MAIN_PAGE, WORKING_PLAN, PC_OUT_JSON, POLL_MS, PRESS_EVERY_MS
import { spawnSync } from "node:child_process";
import { Client } from "pg";

const RUN = process.env.WALK_RUN_ID;
const PLAN = process.env.WORKING_PLAN;
const PAGE = process.env.RUN_MAIN_PAGE;
for (const [n, v] of Object.entries({ WALK_RUN_ID: RUN, WORKING_PLAN: PLAN, RUN_MAIN_PAGE: PAGE }))
  if (!v) throw new Error(`the review-run driver needs ${n}`);

const db = new Client({ connectionString: process.env.SUPABASE_DB_URL });
await db.connect();
const state = async () => (await db.query(
  `SELECT r.status,
          (SELECT count(*) FROM cinatra.artifact_produced_outbox o
            WHERE o.producer_run_id = r.id AND o.status = 'pending') AS pending_outbox,
          (SELECT count(*) FROM cinatra.artifact_review_gates g WHERE g.run_id = r.id) AS gates
     FROM cinatra.agent_runs r WHERE r.id = $1`, [RUN])).rows[0];

const PRESS_EVERY = Number(process.env.PRESS_EVERY_MS ?? 45_000);
const deadline = Date.now() + Number(process.env.POLL_MS ?? 900_000);
let last = "", lastPressAt = 0, shot = false, capture = null;
while (Date.now() < deadline) {
  const s = await state();
  const line = `${s.status} pending_outbox=${s.pending_outbox} gates=${s.gates}`;
  if (line !== last) { console.log(`${new Date().toISOString()} ${line}`); last = line; }
  if (!shot && Number(s.pending_outbox) > 0 && Number(s.gates) === 0) {
    shot = true;
    console.log(`>>> the WORKING window is open at ${new Date().toISOString()}`);
    capture = spawnSync("node", ["evidence/2788-s9d-rework/drivers/2975-reshoot-page-controls.mjs", PLAN],
      { stdio: "inherit", env: process.env }).status;
    console.log(`<<< capture exit ${capture} at ${new Date().toISOString()}`);
  }
  if (Number(s.gates) > 0) { console.log("the gate is on file"); break; }
  if (s.status === "pending_approval" && Date.now() - lastPressAt > PRESS_EVERY) {
    lastPressAt = Date.now();
    const r = spawnSync("node", ["evidence/2788-s9d-rework/drivers/2975-r8-press-approval.mjs", PAGE],
      { stdio: "inherit", env: process.env, timeout: 40_000 });
    console.log(`approval press exit ${r.status}`);
  }
  if (["failed", "stopped"].includes(s.status) && Number(s.gates) === 0) { console.log("the run ended without a gate"); break; }
  await new Promise((r) => setTimeout(r, 250));
}
console.log(JSON.stringify({ shot, captureExit: capture, final: await state() }));
await db.end();
