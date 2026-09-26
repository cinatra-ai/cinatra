// core__0109 — the email fan-out's own ledger path (cinatra#3089, epic #3087
// W1). The operator-upgrade twin of the fresh-install bootstrap DDL
// (`artifactMaterializationLedgerSchemaQueries` in src/lib/artifact-claim-schema.ts,
// extended in the SAME PR) — the core__0103 precedent.
//
// The `path` CHECK on `artifact_materializations` gains 'email_fanout': the send
// boundary now writes one markdown revision per draft item of a send through
// the materialization ledger, keyed by the message identity and the content
// hash, so a retried send reuses the row instead of writing a copy. The fan-out
// needs a path of its own because the ledger's unique key excludes `path` and
// the write core refuses to alias a row of a different path.
//
// Rewriting a CHECK constraint is a constraint change, not a data rewrite: no
// row is touched and every existing row satisfies the widened predicate. No
// backfill — historical raw body rows and their associations stay as they are
// (a forward-only cutover).
//
// DECLARED DESTRUCTIVE, as core__0103 is: widening the CHECK rewrites a
// constraint on a deployed table, which the core-store schema migration gate
// classifies destructive (its add-constraint rule).
//
// SEQ 0109: strictly greater than the highest shipped seq (core__0108).

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it. */
export const emailFanoutLedgerPathDdlSql = `
  ALTER TABLE artifact_materializations DROP CONSTRAINT IF EXISTS artifact_materializations_path_check;
  ALTER TABLE artifact_materializations ADD CONSTRAINT artifact_materializations_path_check
    CHECK (path IN ('end_node_binding','materialize_tool','llm_emit','derived_output','default_road','email_fanout'));
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(emailFanoutLedgerPathDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible ONLY while no fan-out row exists: the narrowed CHECK refuses one,
  // so the constraint add fails loudly — the honest outcome. Rows are never
  // deleted to make the narrowing pass.
  pgm.sql(`
    ALTER TABLE artifact_materializations DROP CONSTRAINT IF EXISTS artifact_materializations_path_check;
    ALTER TABLE artifact_materializations ADD CONSTRAINT artifact_materializations_path_check
      CHECK (path IN ('end_node_binding','materialize_tool','llm_emit','derived_output','default_road'));
  `);
}
