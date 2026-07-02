// core__0007 — schedule↔PM-task sync link table (cinatra#317).
//
// Adds `agent_run_pm_links`: one row per schedule-DEFINING trigger that has been
// mirrored to an external project-management provider (Plane today), keyed by
// run_id (one-to-one with agent_run_triggers, hence with the top-level
// agent_run). A LINK TABLE — not columns on agent_run_triggers — so a PM outage
// / absent provider leaves the trigger lifecycle untouched (the absence of a row
// is the natural "not mirrored" state). external_task_id / synced_at stay null
// until the first successful push; sync_error holds the last fail-open error
// (null = healthy); version is the reconcile loop's optimistic-concurrency
// counter. FK run_id → agent_runs.id ON DELETE CASCADE tears the link row down
// with the run.
//
// ADDITIVE change (a brand-new table, see migrations/README.md "Additive"): it
// rides the idempotent bootstrap DDL (buildCreateStoreSchemaQueries adds the
// SAME CREATE TABLE / CREATE INDEX this PR), so an artifact is NOT required.
// This module ships anyway to keep the fresh-bootstrap and migration paths
// aligned (issue #317 acceptance) and to give the table a ledgered row; it is a
// pure CREATE … IF NOT EXISTS, so it is a no-op on a bootstrap-seeded schema and
// ledger-faked on a fresh install. Unqualified names ride the runner's
// search_path; FK references the app-schema agent_runs (same search_path).

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`CREATE TABLE IF NOT EXISTS agent_run_pm_links (
    run_id text PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
    provider text NOT NULL,
    external_task_id text,
    synced_at timestamptz,
    sync_error text,
    version integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS agent_run_pm_links_provider_idx
    ON agent_run_pm_links (provider);`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible: drop the index then the table. The table is a fresh #317
  // addition, so down() restores the exact pre-0007 shape on any lineage.
  pgm.sql(`DROP INDEX IF EXISTS agent_run_pm_links_provider_idx;`);
  pgm.sql(`DROP TABLE IF EXISTS agent_run_pm_links;`);
}
