// #3749: independent tool-started runs. The bootstrap twin is
// agentRunStartedBySchemaQueries. No parent linkage, FK cascade, or backfill.
export const runStartedByDdlSql = `
  ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS started_by_run_id text;
  CREATE INDEX IF NOT EXISTS agent_runs_started_by_run_id_idx ON agent_runs (started_by_run_id, org_id, created_at) WHERE started_by_run_id IS NOT NULL;
`;
/** @param {Pick<import("node-pg-migrate").MigrationBuilder, "sql">} pgm */
export function up(pgm) { pgm.sql(runStartedByDdlSql); }
/** @param {Pick<import("node-pg-migrate").MigrationBuilder, "sql">} pgm */
export function down(pgm) {
  pgm.sql(`DROP INDEX IF EXISTS agent_runs_started_by_run_id_idx; ALTER TABLE agent_runs DROP COLUMN IF EXISTS started_by_run_id;`);
}
