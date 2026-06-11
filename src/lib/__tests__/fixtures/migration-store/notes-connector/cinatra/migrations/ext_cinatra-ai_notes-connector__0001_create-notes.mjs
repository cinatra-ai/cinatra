// Fixture: a standard node-pg-migrate extension migration (#118). The host
// runs this for trusted-signed installs; unqualified names ride the runner's
// search_path. Safe to re-run (IF NOT EXISTS) per migrations/README.md.

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`CREATE TABLE IF NOT EXISTS ext_cinatra_ai_notes_connector_notes (
  org_id text NOT NULL,
  id text PRIMARY KEY,
  title text,
  done boolean DEFAULT false
);`);
  pgm.sql(
    `CREATE INDEX IF NOT EXISTS ext_cinatra_ai_notes_connector_notes_org_idx ON ext_cinatra_ai_notes_connector_notes (org_id);`,
  );
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`DROP TABLE IF EXISTS ext_cinatra_ai_notes_connector_notes;`);
}
