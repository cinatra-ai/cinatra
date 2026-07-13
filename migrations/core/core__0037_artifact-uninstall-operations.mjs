// core__0037 — artifact-extension uninstall-operation records (cinatra#1432,
// epic #1424).
//
// The extensions-side claim lifecycle wiring makes uninstall archival
// REPLAYABLE: uninstalling a claiming `kind:"artifact"` extension archives its
// eligible semantic assertions in checkpointed batches UNDER AN OPERATION
// RECORD, and a later reinstall INSERTS replacement classic assertions for
// exactly the set that operation archived (archived rows are never
// un-archived — the semantic_assertion append-only guard forbids it). Two
// brand-new tables:
//
//   - artifact_uninstall_operations            one row per archival run (scope
//     'platform' | 'org:<id>' × claiming extension), status running →
//     completed (or failed), jsonb checkpoint so an interrupted archival
//     resumes; replayed_at/replayed_install_id are set once by the reinstall
//     replay (an operation replays at most once).
//   - artifact_uninstall_operation_assertions  append-only lineage: EXACTLY
//     the semantic_assertion rows the operation archived, denormalized with
//     everything replay needs (org/artifact/extension/asserted_by/principal +
//     assertion_basis so replay restores only the CLASSIC subset — BINDING
//     lineage regenerates from current claims, never replayed as classic);
//     UNIQUE (operation_id, assertion_id) makes checkpoint-resumed archival
//     idempotent; BEFORE UPDATE OR DELETE trigger raises (lineage is
//     immutable history).
//
// No FKs on purpose (the artifact_claim_events precedent): operation +
// lineage survive installed_extension deletion and assertion-table evolution.
//
// ADDITIVE (brand-new empty tables; migrations/README.md "Additive") — no
// artifact is REQUIRED. Shipped anyway (the core__0034 precedent) to keep the
// fresh-bootstrap and operator-upgrade paths aligned and give the tables a
// ledgered row. The DDL MIRRORS the idempotent bootstrap
// (buildCreateStoreSchemaQueries → artifactUninstallOperationSchemaQueries,
// which rides the claim-system schema leaf src/lib/artifact-claim-schema.ts —
// bundled there so the store bootstrap wires the whole claim system through one
// spread call, holding the drizzle-store file-size ratchet) — a no-op on a
// bootstrap-seeded schema, ledger-faked on a fresh install, executed by
// `db migrate` on an existing deployment. No `noTransaction()` (guarded DDL
// on empty tables is instant). Unqualified names ride the runner's
// search_path (the app schema).

/** Idempotent DDL mirroring the bootstrap — safe to run after it. */
export const artifactUninstallOperationsDdlSql = `
  CREATE TABLE IF NOT EXISTS artifact_uninstall_operations (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    scope text NOT NULL,
    extension_package text NOT NULL,
    extension_version text NOT NULL,
    actor text NOT NULL,
    status text NOT NULL DEFAULT 'running',
    archived_count integer NOT NULL DEFAULT 0,
    checkpoint jsonb,
    replayed_at timestamptz,
    replayed_install_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    CONSTRAINT artifact_uninstall_operations_scope_check CHECK (scope = 'platform' OR scope LIKE 'org:_%'),
    CONSTRAINT artifact_uninstall_operations_status_check CHECK (status IN ('running','completed','failed'))
  );
  CREATE INDEX IF NOT EXISTS artifact_uninstall_operations_pkg_scope_idx
    ON artifact_uninstall_operations (extension_package, scope, created_at DESC);

  CREATE TABLE IF NOT EXISTS artifact_uninstall_operation_assertions (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    operation_id text NOT NULL,
    assertion_id text NOT NULL,
    org_id text NOT NULL,
    artifact_id text NOT NULL,
    extension text NOT NULL,
    asserted_by text NOT NULL,
    asserted_by_principal text,
    assertion_basis text NOT NULL DEFAULT 'classic',
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT artifact_uninstall_operation_assertions_basis_check CHECK (assertion_basis IN ('binding','classic')),
    CONSTRAINT artifact_uninstall_operation_assertions_op_assertion_uq UNIQUE (operation_id, assertion_id)
  );
  CREATE INDEX IF NOT EXISTS artifact_uninstall_operation_assertions_op_idx
    ON artifact_uninstall_operation_assertions (operation_id, org_id, artifact_id);
  CREATE OR REPLACE FUNCTION fn_artifact_uninstall_op_assertions_append_only() RETURNS trigger LANGUAGE plpgsql AS $body$
  BEGIN
    RAISE EXCEPTION 'artifact_uninstall_operation_assertions is append-only: % forbidden — uninstall lineage is immutable', TG_OP;
  END;
  $body$;
  DROP TRIGGER IF EXISTS trg_artifact_uninstall_op_assertions_append_only ON artifact_uninstall_operation_assertions;
  CREATE TRIGGER trg_artifact_uninstall_op_assertions_append_only BEFORE UPDATE OR DELETE ON artifact_uninstall_operation_assertions FOR EACH ROW EXECUTE FUNCTION fn_artifact_uninstall_op_assertions_append_only();
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(artifactUninstallOperationsDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible in shape: the tables are a fresh addition, so dropping them
  // restores the pre-0037 schema exactly. HONEST COST: operation records and
  // their archived-set lineage are NOT re-derivable (the archived
  // semantic_assertion rows lose their operation grouping), so a reinstall
  // after `--down` cannot replay — the floor rebalance still guarantees every
  // artifact keeps an eligible identity. An operator-initiated `--down`
  // deliberately accepts that (the core__0034 event-log precedent).
  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_artifact_uninstall_op_assertions_append_only ON artifact_uninstall_operation_assertions;
    DROP FUNCTION IF EXISTS fn_artifact_uninstall_op_assertions_append_only();
    DROP TABLE IF EXISTS artifact_uninstall_operation_assertions;
    DROP TABLE IF EXISTS artifact_uninstall_operations;
  `);
}
