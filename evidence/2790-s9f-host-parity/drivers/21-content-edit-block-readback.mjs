// ---------------------------------------------------------------------------
// cinatra#2790 S9f round 2 — THE DATABASE READBACK BEHIND THE CONTENT-EDIT BLOCK.
//
// The probe (drivers/20) drives the turn and prints what it polled. This driver
// asks the database the questions the block's claim rests on, and prints ONLY
// what it read. Its raw output is committed as
// `logs/content-edit-block-readback.txt`, so every row quoted in README.md,
// TIMELINE.md and RUN-READBACK.md can be found in a file the driver wrote rather
// than in prose somebody transcribed.
//
// It writes nothing and asserts nothing.
//
// Usage: node 21-content-edit-block-readback.mjs
//        env: SUPABASE_DB_URL
// ---------------------------------------------------------------------------
import pg from "pg";

const QUERIES = [
  ["every agent_run in the lane, with its MOMENT columns",
   `select id, status, source_type, human_present, lifecycle_moment, lifecycle_card_kind, lifecycle_card_ref, created_at
      from cinatra.agent_runs order by created_at`],
  ["carrier runs of the widget's kind — the run this chain would have created",
   `select count(*) as carrier_runs from cinatra.agent_runs
      where source_type in ('public_site_widget','content_editor_dispatch')`],
  ["recommendation parks — the moment it would have opened",
   `select count(*) as recommendation_parks from cinatra.lifecycle_continuation_park
      where checkpoint like '%recommendation%'`],
  ["widget sessions minted — each row, so the count is BOUND rather than asserted",
   `select jti, client, agent_slug, instance_id, site_origin, scope, created_at
      from cinatra.widget_user_tokens order by created_at`],
  ["the provider that answered, and when — the platform's own metering row",
   `select provider, model, operation, source, occurred_at, created_at from cinatra.usage_events order by created_at`],
];

const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL });
await c.connect();
console.log(`# cinatra#2790 S9f round 2 — content-edit block readback, ${new Date().toISOString()}`);
for (const [title, sql] of QUERIES) {
  console.log(`\n## ${title}`);
  const { rows } = await c.query(sql);
  if (rows.length === 0) { console.log("(no rows)"); continue; }
  for (const row of rows) {
    console.log(
      Object.entries(row)
        // Timestamps print as ISO-8601 UTC WITH MILLISECONDS. The default
        // String(Date) drops them to whole seconds and prints a local zone, and
        // a readback whose precision is lower than the claim it backs is not a
        // readback (convergence round 2).
        .map(([k, v]) => `${k}=${v === null ? "NULL" : v instanceof Date ? v.toISOString() : String(v)}`)
        .join(" | "),
    );
  }
}
await c.end();
