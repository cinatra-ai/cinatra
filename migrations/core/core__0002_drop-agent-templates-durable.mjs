// core__0002 — runner form of migrations/0002_drop-agent-templates-durable.sql.
//
// Issue #84: drop the dead `agent_templates.durable` column. No routing or
// execution code ever read it and every writer only persisted the default
// `false`, so no user-land data is lost.
//
// Re-expresses the shipped hand-apply artifact 1:1 so the node-pg-migrate
// ledger covers the full core history (cinatra#116). Idempotent on every
// lineage (hand-applied, boot-bootstrapped, or fresh — see core__0001 for
// the lineage notes). Unqualified table name: the runner sets search_path
// to the app schema.

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`ALTER TABLE agent_templates
  DROP COLUMN IF EXISTS durable;`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Restore the column shape the bootstrap DDL carried before the drop
  // (a BullMQ distributed-tier flag that only ever held its default).
  pgm.sql(`ALTER TABLE agent_templates
  ADD COLUMN IF NOT EXISTS durable boolean NOT NULL DEFAULT false;`);
}
