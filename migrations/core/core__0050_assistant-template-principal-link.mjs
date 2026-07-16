// core__0050 — the 1:1 agent_templates <-> assistant-user PRINCIPAL link
// (cinatra-ai/cinatra#1037 P1.3). Adds `assistant_user_id` to agent_templates:
// the bare text id of the Better Auth public."user" assistant principal a
// conversational (`agent_kind='assistant'`) template is registered AS. This is
// the seam the generalized assistant-MCP surface (P5.5) was built handle-generic
// against — resolveTemplateLinkedAssistantConfig maps a principal id to its
// persisted sidecar through THIS column, so a linked assistant reaches its
// runtime config instead of falling back to the hardcoded Cinatra reference.
//
// `assistant_user_id` is a bare text column (NO cross-schema FK to public."user",
// exactly like assistant_threads.assistant_user_id and assistant_handles.
// assistant_user_id — the app owns referential integrity across the cinatra <->
// public schema boundary). A PARTIAL UNIQUE index over the non-null values
// enforces the 1:1 (a principal links to at most one template); executor rows
// stay NULL and never collide (partial predicate excludes them).
//
// WHY A MIGRATION. The column + index are additive — the bootstrap DDL
// (buildCreateStoreSchemaQueries, same PR) adds them via ADD COLUMN IF NOT EXISTS
// + CREATE UNIQUE INDEX IF NOT EXISTS, so a fresh install is born at the target
// shape and ledger-fakes this chain. This module carries the SAME additive DDL
// onto the operator upgrade path (core__0046 / core__0026 precedent). No CHECK
// tightening and no backfill: every existing row keeps assistant_user_id NULL,
// which the partial-unique predicate excludes, so the index builds cleanly with
// no pre-existing collisions. The built-in Cinatra principal is linked at boot by
// the assistant-agent registration bootstrap (ensureBuiltInCinatraAssistantAgent,
// runs AFTER migrations) — identity minted at boot, never by a migration, exactly
// like the @cinatra seed and the handle backfill.
//
// Gate class NON-destructive (additive): a new nullable column + a partial unique
// index on that new column — no change to existing data, no NOT NULL on existing
// rows, no tightened constraint, no rewrite.
//
// IDEMPOTENT / LINEAGE-TOLERANT: column IF NOT EXISTS, index IF NOT EXISTS.
// Unqualified names resolve to the app schema the runner sets on search_path.
// down() is a true reverse: drop the index, then the column (loses the link data
// by design — a structural addition, not a rename; boot re-links idempotently).

const LINK_INDEX = "agent_templates_assistant_user_id_uniq";

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(
    `ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS assistant_user_id text;`,
  );
  // Partial UNIQUE index enforces the 1:1 over non-null principal links only;
  // executor rows (assistant_user_id NULL) are excluded and never collide.
  pgm.sql(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${LINK_INDEX} ON agent_templates (assistant_user_id) WHERE assistant_user_id IS NOT NULL;`,
  );
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`DROP INDEX IF EXISTS ${LINK_INDEX};`);
  pgm.sql(`ALTER TABLE agent_templates DROP COLUMN IF EXISTS assistant_user_id;`);
}
