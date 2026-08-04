// core__0090 — relax `skill_match_batch_runs.input_file_id` to NULLABLE
// (setup-flow S6, cinatra#2391: provider-neutral skill auto-matching).
//
// WHAT. One constraint relaxation on a table that exists on deployed
// databases:
//   ALTER TABLE skill_match_batch_runs ALTER COLUMN input_file_id DROP NOT NULL
//
// WHY. The column was NOT NULL because every batch run was an OpenAI v1 batch
// whose submit response carried a provider input-file id. The provider-neutral
// pipeline records runs that legitimately have NO such id: neutral batch-v2
// submissions expose no provider file ids at all, and synchronous fan-out runs
// (batch-less providers; `sync-` batch ids) never touch a provider file. The
// fresh-install bootstrap DDL (src/lib/drizzle-store.ts +
// src/lib/skill-match-run-ddl.ts) describes the nullable shape in the SAME PR;
// this module is the operator-upgrade twin for databases whose table already
// exists with the NOT NULL constraint (ADD COLUMN IF NOT EXISTS cannot express
// a constraint relaxation, and the bootstrap's guarded ALTER only converges
// lineages that re-run it — the deployed constraint change itself is this
// migration's job).
//
// DATA. No row is touched. Existing rows all carry a non-null value (the old
// pipeline always wrote one) and keep it byte-identical; only the column's
// nullability changes. Metadata-only DDL; runs in its own transaction, no
// noTransaction() needed.
//
// IDEMPOTENT / RE-RUNNABLE. `DROP NOT NULL` on an already-nullable column is a
// no-op success in Postgres, so re-running — including on a fresh database
// that bootstrapped the post-migration shape and had the chain ledger-faked —
// is safe. Unqualified names ride the runner's search_path (the app schema).
//
// POSTCONDITION (fail-loud). Asserts the column is nullable in the CURRENT
// schema after the ALTER, so a partial or silently-skipped apply RAISEs and
// rolls the transaction back rather than letting the new pipeline's first
// v2/synchronous run die on a NOT NULL violation at insert time.
//
// SEQ 0090 — strictly greater than the max seq on live origin/main
// (core__0089_agent-assigned-skills). Migration seq is assigned at MERGE: a
// concurrent lane may land an intervening seq first, in which case a
// rename-only renumber of this module + its manifest fragment is normal (the
// runner tolerates sequence gaps).
//
// DOWN. Restores NOT NULL. Rows written by the provider-neutral pipeline can
// hold NULL, so the down first backfills those NULLs with the empty-string
// sentinel '' (not a valid provider file id, so it aliases nothing) and then
// SETs NOT NULL. HONEST COST: the fact "this run had no provider input file"
// is flattened to '' — acceptable for a rollback to a pre-S6 image, which
// only ever reads input_file_id off rows its own (OpenAI v1) pipeline wrote.

/** SQL-identifier escaper for an optional schema qualifier (integration path). */
function escId(s) {
  return String(s).replaceAll('"', '""');
}

/**
 * Build the UP statement list (relax → fail-loud postcondition).
 * @param {string} [schema] optional schema qualifier (integration path).
 * @returns {string[]}
 */
export function buildUpSql(schema) {
  const t = schema
    ? `"${escId(schema)}"."skill_match_batch_runs"`
    : "skill_match_batch_runs";
  const schemaExpr = schema
    ? `'${escId(schema).replaceAll("'", "''")}'`
    : "current_schema()";
  return [
    `ALTER TABLE ${t} ALTER COLUMN input_file_id DROP NOT NULL`,
    `DO $core0090$
DECLARE
  nullable_now bigint;
BEGIN
  SELECT count(*) INTO nullable_now
    FROM information_schema.columns
   WHERE table_schema = ${schemaExpr}
     AND table_name   = 'skill_match_batch_runs'
     AND column_name  = 'input_file_id'
     AND is_nullable  = 'YES';
  IF nullable_now = 0 THEN
    RAISE EXCEPTION 'core__0090: skill_match_batch_runs.input_file_id is still NOT NULL after the relaxation — the provider-neutral pipeline''s first batch-v2/synchronous run would fail at insert. Transaction rolled back (no partial apply).';
  END IF;
END
$core0090$`,
  ];
}

/**
 * Build the DOWN statement list (sentinel-backfill NULLs → SET NOT NULL).
 * @param {string} [schema]
 * @returns {string[]}
 */
export function buildDownSql(schema) {
  const t = schema
    ? `"${escId(schema)}"."skill_match_batch_runs"`
    : "skill_match_batch_runs";
  return [
    `UPDATE ${t} SET input_file_id = '' WHERE input_file_id IS NULL`,
    `ALTER TABLE ${t} ALTER COLUMN input_file_id SET NOT NULL`,
  ];
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  for (const sql of buildUpSql()) {
    pgm.sql(`${sql};`);
  }
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  for (const sql of buildDownSql()) {
    pgm.sql(`${sql};`);
  }
}
