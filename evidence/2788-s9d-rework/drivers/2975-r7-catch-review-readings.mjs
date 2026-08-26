// CATCH THE REVIEW STEP'S "WORKING" READING (cinatra#2970, PR #2975 round 7).
//
// `runReviewStepReading` answers `working` while the run has a PENDING
// artifact-produced outbox row and no gate yet, and `review` once the sweeper has
// opened a gate from that row. On this lane the second follows the first by a few
// seconds, so the placeholder cannot be photographed by opening the page after the
// run finishes: this driver polls the run's OWN rows four times a second and fires
// the capture the instant the window opens.
//
// It presses a mid-run approval step with a SHORT budget, so a slow page can never
// block the poller across the window. Nothing here writes a row.
//
//   env: WALK_BASE, SUPABASE_DB_URL, WALK_RUN_ID, RUN_MAIN_PAGE, WORKING_PLAN,
//        PRESS_DRIVER, POLL_MS
import { spawnSync } from "node:child_process";
import { Client } from "pg";

const RUN = process.env.WALK_RUN_ID;
const PLAN = process.env.WORKING_PLAN;
const PAGE = process.env.RUN_MAIN_PAGE;
const PRESS = process.env.PRESS_DRIVER;
for (const [n, v] of Object.entries({ WALK_RUN_ID: RUN, WORKING_PLAN: PLAN, RUN_MAIN_PAGE: PAGE }))
  if (!v) throw new Error(`the review-reading catcher needs ${n}`);

const db = new Client({ connectionString: process.env.SUPABASE_DB_URL });
await db.connect();
const state = async () => (await db.query(
  `SELECT r.status,
          (SELECT count(*) FROM cinatra.artifact_produced_outbox o
            WHERE o.producer_run_id = r.id AND o.status = 'pending') AS pending_outbox,
          (SELECT count(*) FROM cinatra.artifact_review_gates g WHERE g.run_id = r.id) AS gates
     FROM cinatra.agent_runs r WHERE r.id = $1`, [RUN])).rows[0];

let last = "", approvalTicks = 0, pressed = false, shot = false;
const deadline = Date.now() + Number(process.env.POLL_MS ?? 400_000);
while (Date.now() < deadline) {
  const s = await state();
  const line = `${s.status} pending_outbox=${s.pending_outbox} gates=${s.gates}`;
  if (line !== last) { console.log(`${new Date().toISOString()} ${line}`); last = line; approvalTicks = 0; pressed = false; }
  if (!shot && Number(s.pending_outbox) > 0 && Number(s.gates) === 0) {
    shot = true;
    console.log(`>>> the WORKING window is open at ${new Date().toISOString()}`);
    const r = spawnSync("node", ["evidence/2788-s9d-rework/drivers/2975-reshoot-page-controls.mjs", PLAN], { stdio: "inherit", env: process.env });
    console.log(`<<< capture exit ${r.status} at ${new Date().toISOString()}`);
    break;
  }
  if (s.status === "pending_approval" && PRESS) {
    approvalTicks += 1;
    if (approvalTicks === 20 && !pressed) {
      pressed = true;
      console.log(`approval press exit ${spawnSync("node", [PRESS, PAGE], { stdio: "inherit", env: process.env, timeout: 60_000 }).status}`);
    }
  }
  if (["failed", "stopped"].includes(s.status) && Number(s.gates) === 0) { console.log("the run ended without a gate"); break; }
  await new Promise((r) => setTimeout(r, 250));
}
console.log(JSON.stringify({ shot, final: await state() }));
await db.end();
