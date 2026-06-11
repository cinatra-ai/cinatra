// core__0003: drop the dormant `extension_migrations` ledger (cinatra#118).
//
// The table backed the RETIRED extension JSON-DSL migration machinery
// (extension-migration-dsl/runner). It was created by the bootstrap DDL on
// every lineage but NO extension ever declared `cinatra.migrations`, so the
// table is empty everywhere — no user-land data is lost. Extension
// migrations now record into the SHARED node-pg-migrate ledger
// (`pgmigrations`, `ext_<scope>_<pkg>__NNNN…` names); see migrations/README.md.
//
// Safe to re-run / fresh-lineage tolerant: guarded DO block — fresh schemas
// no longer create the table at all (the bootstrap DDL entry was removed in
// the same change). Belt-and-braces for the SENSITIVE drop: if the ledger
// somehow carries rows (it never should — no shipped code path ever wrote
// one), REFUSE instead of dropping, so an operator looks before any data is
// lost. Unqualified names ride the runner's search_path.

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`DO $$
BEGIN
  IF to_regclass('extension_migrations') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM extension_migrations LIMIT 1) THEN
      RAISE EXCEPTION 'extension_migrations is not empty — the retired JSON-DSL ledger was expected dormant (cinatra#118); refusing to drop. Inspect and clear the rows manually first.';
    END IF;
    DROP TABLE extension_migrations;
  END IF;
END $$;`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Restores the pre-#118 (always-empty) shape exactly as the bootstrap DDL
  // created it; the rows were never written by any shipped code path.
  pgm.sql(`CREATE TABLE IF NOT EXISTS extension_migrations (
  package_name text NOT NULL,
  migration_id text NOT NULL,
  migration_hash text NOT NULL,
  package_version text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (package_name, migration_id)
);`);
}
