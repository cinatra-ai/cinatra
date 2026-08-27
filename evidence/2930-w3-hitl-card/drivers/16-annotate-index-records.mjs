// THE PROSE THE SHIPPED RECORDER DOES NOT WRITE, added to the records it DID.
//
// `observeCapture` writes the MEASUREMENT — the cell, the host, the kind, the
// state, the URL, the image and its hash, the pinned instance and every counted
// assertion. It writes no `runtime`, no `runId`, no database readback and no
// provider evidence, and every record already committed in the canonical index
// carries all four, added the same way by the round that made it.
//
// This driver adds exactly those fields to the records THIS round's walk wrote,
// and nothing else: no assertion is touched, no count is edited, no hash is
// recomputed from a record rather than from disk. It re-validates the whole
// index with the SHIPPED validator afterwards and refuses to write if anything
// it added made a record invalid.
//
//   env: SUPABASE_DB_URL, WALK_RUN_ID, INDEX_PATH, CELLS (comma-separated),
//        LANE_RUNTIME, PROVIDER_EVIDENCE_JSON
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { Client } from "pg";
import { validateCaptureIndex, hashFile } from "../../../scripts/audit/lib/chat-hitl-capture-recorder.mjs";

const INDEX = process.env.INDEX_PATH ?? "scripts/ci/chat-hitl-capture-index.json";
const RUN = process.env.WALK_RUN_ID;
const CELLS = new Set((process.env.CELLS ?? "").split(",").map((c) => c.trim()).filter(Boolean));
const RUNTIME = process.env.LANE_RUNTIME;
const PROVIDER = JSON.parse(process.env.PROVIDER_EVIDENCE_JSON ?? "null");
for (const [n, v] of Object.entries({ WALK_RUN_ID: RUN, LANE_RUNTIME: RUNTIME }))
  if (!v) throw new Error(`the annotate driver needs ${n}`);
if (CELLS.size === 0) throw new Error("the annotate driver needs CELLS");

const db = new Client({ connectionString: process.env.SUPABASE_DB_URL });
await db.connect();
const dbAt = (await db.query(
  `SELECT id, status, created_at, started_at, completed_at, lifecycle_moment, lifecycle_card_kind,
          input_params, a2a_task_id, now() AS read_at
     FROM cinatra.agent_runs WHERE id=$1`, [RUN])).rows[0] ?? null;
const gates = (await db.query(
  `SELECT review_task_id, x_renderer, field_name, materialized_at FROM cinatra.agent_run_hitl_gates
    WHERE run_id=$1 ORDER BY created_at`, [RUN])).rows;
await db.end();

const index = JSON.parse(readFileSync(resolve(INDEX), "utf8"));
let touched = 0;
for (const record of index.records ?? []) {
  if (!CELLS.has(record.cell)) continue;
  record.runtime = RUNTIME;
  record.runId = RUN;
  record.dbAt = dbAt;
  record.gatesAtCapture = gates;
  if (PROVIDER) record.providerEvidence = PROVIDER;
  record.note = record.note ?? null;
  touched += 1;
}
if (touched !== CELLS.size) throw new Error(`asked to annotate ${CELLS.size} cell(s) and found ${touched}`);

const violations = validateCaptureIndex({
  index,
  hashOf: (rel) => hashFile(join(process.cwd(), rel)),
  tier: "graded",
});
if (violations.length > 0) {
  for (const v of violations) console.error(`  ${v}`);
  throw new Error(`the annotated index would be refused (${violations.length} violation(s)) — nothing written`);
}
writeFileSync(resolve(INDEX), `${JSON.stringify(index, null, 2)}\n`);
console.log(`annotated ${touched} record(s) in ${INDEX}; the shipped validator accepts all ${index.records.length}`);
