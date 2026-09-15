// core__0102 — the default road's ledger columns and its ledger path
// (cinatra#3029, epic #3023 W5). The operator-upgrade twin of the fresh-install
// bootstrap DDL (`buildCreateStoreSchemaQueries` in src/lib/drizzle-store.ts,
// extended in the SAME PR) — the two halves ship together, the core__0091 /
// core__0101 precedent.
//
// FOUR additive nullable columns on `artifact_materializations`, plus a widened
// `path` CHECK:
//
//   - `detection_rung`       (text)             — the ladder rung that decided
//                                                 the output's form: explicit,
//                                                 signature, structure, name,
//                                                 model or base.
//   - `detection_reason`     (text)             — why that rung decided as it
//                                                 did (the rung's own words).
//   - `detection_confidence` (double precision) — the model rung's confidence;
//                                                 null on every other rung.
//   - `detection_model`      (text)             — the model the model rung
//                                                 used; null on every other rung.
//
// WHY: before this slice an end-node output that no binding named was typed by
// one classifier call against the agent's declared output types and, on a miss,
// was DROPPED with an advisory — nothing recorded WHY an output was named what
// it was named, because there was only ever one way to name it. The default road
// types every qualifying output through a ladder of six rungs, so the row must
// carry the deciding rung or the decision is unauditable.
//
// The `path` CHECK gains 'default_road' — the default road's own ledger path,
// distinct from the retired 'derived_output' (which stays legal so historical
// rows keep reading). Rewriting a CHECK constraint is a constraint change, not a
// data rewrite: no row is touched, and every existing row satisfies the widened
// predicate.
//
// No backfill: every existing row reads NULL on all four columns, which is
// exactly right — those rows were written by paths that do not run the ladder.
//
// DECLARED DESTRUCTIVE, AND MEASURED RATHER THAN ASSERTED. An earlier draft of
// this header claimed the core-store schema migration gate classifies the change
// NON-destructive. Run at this branch's head the gate says otherwise: the four
// columns are additive, but WIDENING THE PATH CHECK REWRITES A CONSTRAINT on a
// deployed table, which is the gate's own add-constraint rule, and it asks for a
// fragment carrying "destructive": true. The fragment now carries it. Nothing
// about the change moved — no row is touched and every existing row satisfies the
// widened predicate — only the claim about how it is classified.
//
// SEQ 0103. This fragment was authored at 0102, strictly greater than the max
// shipped seq at the time (core__0101); the launch-scope anchor claimed 0102 on
// the default branch while this branch was open, so the pair is renumbered onto
// the next free number, which is the rename the convention expects
// (migrations/README.md).

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it. */
export const defaultRoadLedgerDdlSql = `
  ALTER TABLE artifact_materializations ADD COLUMN IF NOT EXISTS detection_rung text;
  ALTER TABLE artifact_materializations ADD COLUMN IF NOT EXISTS detection_reason text;
  ALTER TABLE artifact_materializations ADD COLUMN IF NOT EXISTS detection_confidence double precision;
  ALTER TABLE artifact_materializations ADD COLUMN IF NOT EXISTS detection_model text;
  ALTER TABLE artifact_materializations DROP CONSTRAINT IF EXISTS artifact_materializations_path_check;
  ALTER TABLE artifact_materializations ADD CONSTRAINT artifact_materializations_path_check
    CHECK (path IN ('end_node_binding','materialize_tool','llm_emit','derived_output','default_road'));
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(defaultRoadLedgerDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible ONLY while no `default_road` row exists: the narrowed CHECK
  // refuses one. Drop those rows first, or the constraint add fails — which is
  // the honest outcome (a down-migration that silently kept unreadable rows
  // would be worse).
  pgm.sql(`
    ALTER TABLE artifact_materializations DROP COLUMN IF EXISTS detection_rung;
    ALTER TABLE artifact_materializations DROP COLUMN IF EXISTS detection_reason;
    ALTER TABLE artifact_materializations DROP COLUMN IF EXISTS detection_confidence;
    ALTER TABLE artifact_materializations DROP COLUMN IF EXISTS detection_model;
    ALTER TABLE artifact_materializations DROP CONSTRAINT IF EXISTS artifact_materializations_path_check;
    ALTER TABLE artifact_materializations ADD CONSTRAINT artifact_materializations_path_check
      CHECK (path IN ('end_node_binding','materialize_tool','llm_emit','derived_output'));
  `);
}
