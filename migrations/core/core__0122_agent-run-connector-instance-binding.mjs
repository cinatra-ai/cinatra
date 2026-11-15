// cinatra#4220: the agent run's host-derived connector-instance binding. The
// bootstrap twin is agentRunConnectorInstanceBindingSchemaQueries. Nullable; no
// backfill, index or constraint.
export const runConnectorInstanceBindingDdlSql = `
  ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS connector_instance_binding text;
`;
/** @param {Pick<import("node-pg-migrate").MigrationBuilder, "sql">} pgm */
export function up(pgm) { pgm.sql(runConnectorInstanceBindingDdlSql); }
/** @param {Pick<import("node-pg-migrate").MigrationBuilder, "sql">} pgm */
export function down(pgm) { pgm.sql(`ALTER TABLE agent_runs DROP COLUMN IF EXISTS connector_instance_binding;`); }
