// core__0005: convert the extension install-op journal to APPEND-ONLY
// (cinatra#158).
//
// BEFORE: `extension_install_ops` kept ONE row per (package, org) — `beginInstallOp`
// did a reset-on-begin UPDATE, so a new install attempt DESTROYED the prior
// install's `finalized` op. That forced three best-effort "restore choreographies"
// (re-begin + re-finalize the prior op) on every failed update, in the install
// pipeline and the workflow saga.
//
// AFTER: one row per ATTEMPT (PK install_op_id, unchanged). The TRUST INVARIANT —
// "at most one `finalized` op per (package, org), and that single op IS the install
// anchor" — moves to the DB as a PARTIAL UNIQUE index on (package_name, org_id)
// WHERE phase='finalized' (plus the GLOBAL org_id IS NULL twin). A successful
// re-install/update demotes the prior `finalized` op to the terminal `superseded`
// phase and promotes its own; a FAILED update leaves its attempt terminalized and
// never touches the prior anchor — so no journal restore is needed.
//
// This migration: drops the two OLD full unique indexes, adds the partial-finalized
// unique indexes + a (package_name, org_id, phase) scan index, and widens the phase
// CHECK to admit 'superseded'.
//
// DEPLOY BOUNDARY (coordinated, NON-rolling): PRE-0005 application code did the
// reset-on-begin UPDATE keyed by (package_name, org_id). Once the full unique
// indexes are gone, that old UPDATE could touch MULTIPLE appended rows. Apply 0005
// with old writers DRAINED (a coordinated deploy where pre-0005 and post-0005 app
// processes do not write the journal concurrently). cinatra is a single writable
// install region per deploy and the install path is serialized per-package
// in-process, so this is the standard release boundary, not a rolling overlap.
//
// Idempotent: DROP/CREATE INDEX IF [NOT] EXISTS + a guarded CHECK rebuild. Data is
// fully preserved — append-only is strictly more permissive than single-row, so no
// existing row can violate the new model. Unqualified names ride the runner's
// search_path.

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  // Drop the OLD single-row-per-(pkg,org) unique indexes.
  pgm.sql(`DROP INDEX IF EXISTS extension_install_ops_pkg_org_uniq;`);
  pgm.sql(`DROP INDEX IF EXISTS extension_install_ops_pkg_global_uniq;`);

  // Enforce AT MOST ONE finalized op per (package, org) — the single install anchor.
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS extension_install_ops_one_finalized
    ON extension_install_ops (package_name, org_id) WHERE phase = 'finalized';`);
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS extension_install_ops_one_finalized_global
    ON extension_install_ops (package_name) WHERE phase = 'finalized' AND org_id IS NULL;`);

  // Scan index for the anchor / non-finalized-window / boot-sweeper reads.
  pgm.sql(`CREATE INDEX IF NOT EXISTS extension_install_ops_scope_phase_idx
    ON extension_install_ops (package_name, org_id, phase);`);

  // Widen the phase CHECK to admit the new terminal 'superseded' phase.
  pgm.sql(`DO $$
    DECLARE def text;
    BEGIN
      SELECT pg_get_constraintdef(c.oid) INTO def
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'extension_install_ops'
        AND c.conname = 'extension_install_ops_phase_check';
      IF def IS NOT NULL AND def NOT LIKE '%superseded%' THEN
        ALTER TABLE extension_install_ops DROP CONSTRAINT extension_install_ops_phase_check;
        def := NULL;
      END IF;
      IF def IS NULL THEN
        ALTER TABLE extension_install_ops
          ADD CONSTRAINT extension_install_ops_phase_check
          CHECK (phase IN ('materialized','granted','preflighted','writing','finalized','failed','rolled_back','superseded'));
      END IF;
    END $$;`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Best-effort inverse. Re-creating the OLD full unique indexes is only valid if
  // the table currently holds at most one row per (package, org) — which is NOT
  // guaranteed once append-only attempts have accumulated. This down() is provided
  // for completeness; it MAY fail on a table that already has multiple attempts per
  // scope (a forward-only durability fix). 'superseded' rows are first collapsed to
  // 'rolled_back' so the narrowed CHECK accepts them.
  pgm.sql(`DROP INDEX IF EXISTS extension_install_ops_scope_phase_idx;`);
  pgm.sql(`DROP INDEX IF EXISTS extension_install_ops_one_finalized;`);
  pgm.sql(`DROP INDEX IF EXISTS extension_install_ops_one_finalized_global;`);
  pgm.sql(`UPDATE extension_install_ops SET phase = 'rolled_back' WHERE phase = 'superseded';`);
  pgm.sql(`DO $$
    DECLARE def text;
    BEGIN
      SELECT pg_get_constraintdef(c.oid) INTO def
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'extension_install_ops'
        AND c.conname = 'extension_install_ops_phase_check';
      IF def IS NOT NULL THEN
        ALTER TABLE extension_install_ops DROP CONSTRAINT extension_install_ops_phase_check;
      END IF;
      ALTER TABLE extension_install_ops
        ADD CONSTRAINT extension_install_ops_phase_check
        CHECK (phase IN ('materialized','granted','preflighted','writing','finalized','failed','rolled_back'));
    END $$;`);
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS extension_install_ops_pkg_org_uniq
    ON extension_install_ops (package_name, org_id);`);
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS extension_install_ops_pkg_global_uniq
    ON extension_install_ops (package_name) WHERE org_id IS NULL;`);
}
