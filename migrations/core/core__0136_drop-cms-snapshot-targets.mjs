// core__0136 — drop the unused CMS snapshot target table (cinatra#4854).
//
// WHY. core__0079 (cinatra#2038, S0) created cms_snapshot_targets for the CMS
// page snapshot capture: one row per captured snapshot, with its apply binding.
// The only writer, the page snapshot capture, left core in cinatra#4597
// (cinatra#3862 leg 7); no core code and no pinned extension reads or writes
// the table since then. This change removes the table and its index from the
// fresh-install bootstrap DDL (src/lib/artifacts/artifact-review-gate-schema.ts)
// and the Drizzle definition; `CREATE TABLE IF NOT EXISTS` is a no-op on an
// existing database, so this module removes the table there.
//
// ROWS. A database that still holds rows (written before cinatra#4597) loses
// them: no code reads them, no table has a foreign key to this one, and it
// has no foreign key of its own. The index and the UNIQUE constraint drop with
// the table.
//
// IDEMPOTENT. `DROP TABLE IF EXISTS` is a no-op on a schema that never had the
// table (a fresh install ledger-fakes this module anyway) or already dropped
// it. Unqualified name: the runner sets search_path to the app schema.
//
// DOWN. Recreates the empty table and its index in the core__0079 shape. Rows
// dropped by up() are not restored.

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`DROP TABLE IF EXISTS cms_snapshot_targets;`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`
  CREATE TABLE IF NOT EXISTS cms_snapshot_targets (
    id                     text PRIMARY KEY,
    artifact_id            text NOT NULL,
    snapshot_revision_id   text NOT NULL,
    scope_manifest         jsonb NOT NULL DEFAULT '{"paths":[]}'::jsonb,
    connector_instance     text NOT NULL,
    resource_type          text NOT NULL,
    resource_id            text,
    base_remote_revision_ref text,
    operation_id           text NOT NULL,
    created_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cms_snapshot_targets_operation_uniq UNIQUE (operation_id)
  );
  CREATE INDEX IF NOT EXISTS cms_snapshot_targets_artifact_idx
    ON cms_snapshot_targets (artifact_id);
`);
}
