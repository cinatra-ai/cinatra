// ---------------------------------------------------------------------------
// cinatra#2790 S9f — the pictured run, READ OUT OF THE DATABASE.
//
// WHY THIS FILE EXISTS. The sequence recorder (14) stamps what it needs for the
// cells; a convergence review pointed out that RUN-READBACK.md was quoting rows
// the committed artifacts did not carry — `agent_runs.created_at`,
// `source_type`, the (empty) `run_rejected_recommendations` result, and the
// provider meter. A readback nobody can re-derive is a claim, not a readback.
//
// So this file asks for exactly those rows and writes the answer verbatim to
// `logs/review-reshoot-db-readback.json`. It only ever SELECTs.
//
// Usage: node 16-review-reshoot-db-readback.mjs <runId> <outFile>
//        env: SUPABASE_DB_URL
// ---------------------------------------------------------------------------
import { writeFileSync } from "node:fs";
import pg from "pg";

const RUN = process.argv[2];
const OUT = process.argv[3];
if (!RUN || !OUT || !process.env.SUPABASE_DB_URL) {
  throw new Error("usage: 16-review-reshoot-db-readback.mjs <runId> <outFile>; set SUPABASE_DB_URL");
}
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL });
await c.connect();
const q = async (text, values = []) => (await c.query(text, values)).rows;
const out = { runId: RUN, readAt: new Date().toISOString(), readBy: "16-review-reshoot-db-readback.mjs" };
out.agent_runs = await q(
  `select id, status, human_present, source_type, created_at, completed_at, coalesce(error,'') as error
     from cinatra.agent_runs where id = $1`, [RUN]);
out.lifecycle_continuation_park = await q(
  `select checkpoint, status, created_at, resolved_at
     from cinatra.lifecycle_continuation_park where run_id = $1`, [RUN]);
out.run_selected_skill_revisions = await q(
  `select skill_id, selection_source, selected_at
     from cinatra.run_selected_skill_revisions where run_id = $1 order by skill_id`, [RUN]);
out.run_rejected_recommendations = await q(
  `select skill_id, recommendation_source
     from cinatra.run_rejected_recommendations where run_id = $1`, [RUN]);
out.representation = await q(
  `select id, artifact_id, revision, form, created_at
     from cinatra.representation where created_by_run_id = $1 order by created_at`, [RUN]);
out.artifact_produced_outbox = await q(
  `select emitter, origin_kind, created_at, processed_at
     from cinatra.artifact_produced_outbox where producer_run_id = $1`, [RUN]);
out.artifact_review_gates = await q(
  `select id, review_task_id, status, created_at
     from cinatra.artifact_review_gates where run_id = $1`, [RUN]);
// THE PROVIDER METER. `usage_events` carries no run id on this schema, so this
// is deliberately reported TWO ways — the whole database, and the window this
// run occupied — and neither is an attribution of a single call.
out.usage_events_whole_database = await q(
  `select provider, count(*)::int as rows from cinatra.usage_events group by provider order by rows desc`);
const from = out.agent_runs[0]?.created_at ?? null;
out.usage_events_window = from
  ? await q(
      `select provider, model, count(*)::int as rows, min(created_at) as first_at, max(created_at) as last_at
         from cinatra.usage_events
        where created_at >= $1 and created_at <= $2
        group by provider, model order by rows desc`,
      [from, new Date(new Date(from).getTime() + 4 * 60 * 1000).toISOString()],
    )
  : [];
out.usage_events_window_bounds = from
  ? { from, to: new Date(new Date(from).getTime() + 4 * 60 * 1000).toISOString(), note: "the run's creation plus four minutes; usage_events has no run id column on this schema" }
  : null;
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ wrote: OUT, tables: Object.keys(out).length }));
await c.end();
