// core__0130 — the publish card's rows on `agent_templates` (cinatra#4150).
// Operator-upgrade twin of the fresh-install bootstrap DDL
// (`agentTemplateRunGateSchemaQueries` in src/lib/extension-grant-schema.ts),
// shipped in the SAME change (the core__0118 precedent).
//
// WHAT. ONE additive nullable column, `publish_rows` (text, JSON-as-text like
// `publishing_steps`): for each node the compiled OAS declares
// `metadata.cinatra.publishes: true`, the rows its
// `metadata.cinatra.publishRows` declares, `{ [nodeId]: [{ label, input }] }`.
// Written by the install, import, seed and recompile writers from the
// compiler's `publishRows`. null = unknown: a row written before this column
// existed, or by a writer that does not take the rows from a compile. NOTHING
// READS IT TO DECIDE YET: the publish card that shows the rows lands later.
//
// NO BACKFILL AND NO STORED VALUE CHANGES. No default, no constraint: every
// existing row reads NULL. The schema-migration gate classifies this
// NON-destructive.
//
// LOCKS. The column add is catalog-only (nullable, no default: no rewrite and
// no scan), so its ACCESS EXCLUSIVE lock is held for milliseconds once granted.
//
// LOCK WAIT. As core__0126: `up` runs outside a transaction and sets
// lock_timeout = PUBLISH_ROWS_LOCK_TIMEOUT_MS on its session first and resets it
// last, so an ALTER that waits behind a long reader fails (55P03) instead of
// queueing the application's statements behind it. The migration then stops
// with no ledger row, and the next run replays it.
//
// IDEMPOTENT. ADD COLUMN IF NOT EXISTS: a replay, or a run after the bootstrap
// leaf, changes nothing.
//
// DOWN drops the column and every stored row declaration with it. A later
// recompile or reinstall writes the rows again from the pack; down is safe only
// once no deployed code reads the column.
//
// SEQ 0130: 0128 is the highest sequence on main (2026-11-14); open changes
// claim 0115, 0116 and 0129. A rename-only renumber at merge
// is normal. Unqualified names ride the runner's search_path (the app schema).

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it. */
export const agentTemplatePublishRowsDdlSql = `ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS publish_rows text`;

/** The one statement of `down`: it removes only what `up` added. */
export const agentTemplatePublishRowsDownSql = `ALTER TABLE agent_templates DROP COLUMN IF EXISTS publish_rows`;

/** The longest wait for the lock `up` takes (LOCK WAIT above), in ms. */
export const PUBLISH_ROWS_LOCK_TIMEOUT_MS = 5_000;

/** @param {Pick<import("node-pg-migrate").MigrationBuilder, "sql" | "noTransaction">} pgm */
export function up(pgm) {
  // One autocommit statement each; the lock_timeout is the session's, so it
  // binds the ALTER between the SET and the RESET.
  pgm.noTransaction();
  pgm.sql(`SET lock_timeout = ${PUBLISH_ROWS_LOCK_TIMEOUT_MS}`);
  pgm.sql(agentTemplatePublishRowsDdlSql);
  pgm.sql("RESET lock_timeout");
}

/** @param {Pick<import("node-pg-migrate").MigrationBuilder, "sql">} pgm */
export function down(pgm) {
  pgm.sql(agentTemplatePublishRowsDownSql);
}
