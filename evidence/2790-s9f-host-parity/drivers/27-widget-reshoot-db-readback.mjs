// ---------------------------------------------------------------------------
// cinatra#2790 S9f — the WIDGET re-shoot's database readback, on its own.
//
// WHY IT IS SEPARATE. `24-widget-real-hold-sequence.mjs` reads its rows back at
// the end of the sequence, and three of those reads named columns this schema
// does not have (`run_selected_skill_revisions.source`,
// `lifecycle_continuation_park.updated_at`), so they answered with an error
// string instead of rows. The columns were wrong, never the data: every row
// below was written by the app's own dispatch during the sequence and is read
// here, afterwards, through the names the schema actually carries. The park is
// also re-read AFTER the release rather than at the moment the run row first
// appeared, which is when the sequence happened to look.
//
// It writes NOTHING. Every statement is a SELECT.
//
// Usage: node 27-widget-reshoot-db-readback.mjs <runId> <outFile>
//        env: SUPABASE_DB_URL
// ---------------------------------------------------------------------------
import { Client } from "pg";
import fs from "node:fs";

const RUN_ID = process.argv[2];
const OUT = process.argv[3];
const DB = process.env.SUPABASE_DB_URL;
if (!RUN_ID || !OUT || !DB) throw new Error("usage: <runId> <outFile>; set SUPABASE_DB_URL");

const client = new Client({ connectionString: DB });
await client.connect();
const q = async (text, values = []) => (await client.query(text, values)).rows;

const out = {
  runId: RUN_ID,
  run: await q(
    `select id, status, human_present, template_id, source_type, created_at
       from cinatra.agent_runs where id = $1`,
    [RUN_ID],
  ),
  park: await q(
    `select id, checkpoint, status, event_id, created_at, resolved_at
       from cinatra.lifecycle_continuation_park where run_id = $1 order by created_at`,
    [RUN_ID],
  ),
  // THE DECISION ROWS. Three, for four decided skills — and that is the point
  // of this round: the fourth was settled by a press on its OWN Skip, which
  // writes no row here at all.
  selectedSkillRevisions: await q(
    `select skill_id, selection_source, selected_at
       from cinatra.run_selected_skill_revisions where run_id = $1 order by skill_id`,
    [RUN_ID],
  ),
  // The run-level skip marker: absent, and correct — the row was not skipped as
  // a whole, one skill of it was.
  runRecommendationSkips: await q(
    `select run_id, skipped_by, skipped_at from cinatra.run_recommendation_skips where run_id = $1`,
    [RUN_ID],
  ),
  // The efficacy half: also absent, and also correct — it records a skill the
  // scorer RECOMMENDED and the reader did not keep, and nothing here was
  // recommended (every offered row below is a force-add).
  rejectedRecommendations: await q(
    `select skill_id, recommendation_source from cinatra.run_rejected_recommendations where run_id = $1`,
    [RUN_ID],
  ),
  // THE OFFER — the durable record of what the card asked about, which is what
  // the settled row now states an outcome for, one chip per entry.
  offeredSet: await q(
    `select skill_id, skill_revision_id, recommended, offered_rank, offered_at
       from cinatra.run_recommendation_offered_set where run_id = $1 order by offered_rank`,
    [RUN_ID],
  ),
  usageEvents: await q(
    `select provider, model, created_at from cinatra.usage_events
       where created_at >= (select created_at from cinatra.agent_runs where id = $1)
       order by created_at limit 20`,
    [RUN_ID],
  ),
};
await client.end();
fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
