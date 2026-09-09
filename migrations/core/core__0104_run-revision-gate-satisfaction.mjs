// core__0104 — the same-artifact revision's two schema facts (cinatra#3030,
// epic #3023 W6; plan (C) item 0.30). The operator-upgrade twin of the
// fresh-install bootstrap DDL (`artifactReviewGateSchemaQueries` in
// src/lib/artifacts/artifact-review-gate-schema.ts, extended in the SAME pull
// request) — the two halves ship together, the core__0099 / core__0103
// precedent.
//
// TWO CHANGES:
//
//   1. The `artifact_produced_outbox` emitter CHECK gains
//      'artifact_revision_append'. A mid-run write that appends the next
//      revision of an existing artifact is not the same road as the mint that
//      created it, and the closed emitter set is the audit surface: one emitter
//      standing for both would make "was this artifact created here or revised
//      here" unanswerable on the row.
//
//   2. A new `artifact_revision_review_satisfaction` table keyed on
//      (organisation, artifact, representation revision). Item 0.30: "the
//      caller's own declared gate is recorded as the review of those revisions,
//      and the produced-output road, when it fires, resolves to that gate
//      instead of opening a second — a satisfaction rule keyed on the artifact
//      revision and the run." The primary key IS the rule: one revision names
//      exactly one satisfying gate.
//
// The CHECK widen is a PURE WIDENING: every value the old predicate accepted the
// new one accepts, so no committed outbox row can become invalid, no row is
// rewritten, and the re-validation scan the ADD CONSTRAINT performs passes by
// construction.
//
// SEQ 0104 — 0103 is the highest sequence on main at authoring time, so 0104 is
// the next free one.
//
// DOWN. Two halves, and the second one REFUSES TO DESTROY REVIEW PROVENANCE.
//
//   - The CHECK narrows back to the four-emitter vocabulary. HONEST COST: an
//     instance that has already appended a revision carries
//     `artifact_revision_append` rows and the narrowed constraint refuses to
//     validate against them, so `--down` fails loudly on exactly the instances
//     where the forward shape is load-bearing. That is the correct failure:
//     deleting an outbox row to make a revert succeed would drop a review the
//     product opened.
//   - The satisfaction table is dropped ONLY WHEN IT IS EMPTY. A non-empty table
//     records which gate reviewed which revision; dropping it would erase that
//     answer with no way to recover it, so the down raises instead.
//
// Unqualified names ride the runner's search_path (the app schema), matching
// every sibling module in this chain.

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it, and a
 *  no-op on any database the bootstrap has already created wide. */
export const runRevisionGateSatisfactionDdlSql = `
  ALTER TABLE artifact_produced_outbox DROP CONSTRAINT IF EXISTS artifact_produced_outbox_emitter_check;
  ALTER TABLE artifact_produced_outbox ADD CONSTRAINT artifact_produced_outbox_emitter_check
    CHECK (emitter IN ('createSemanticArtifact','dashboard_twin_writer','object_cms_snapshot_capture','object_snapshot_mint','artifact_revision_append'));

  CREATE TABLE IF NOT EXISTS artifact_revision_review_satisfaction (
    org_id                     text NOT NULL,
    artifact_id                text NOT NULL,
    representation_revision_id text NOT NULL,
    run_id                     text NOT NULL,
    review_task_id             text NOT NULL,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, artifact_id, representation_revision_id)
  );

  CREATE INDEX IF NOT EXISTS artifact_revision_review_satisfaction_gate_idx
    ON artifact_revision_review_satisfaction (org_id, run_id, review_task_id);
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(runRevisionGateSatisfactionDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // The table goes ONLY when it holds nothing. A row here is the record of which
  // gate reviewed which revision; a revert that erases it answers a question
  // nobody can ask again.
  pgm.sql(`
    DO $$
    BEGIN
      IF to_regclass('artifact_revision_review_satisfaction') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM artifact_revision_review_satisfaction) THEN
          RAISE EXCEPTION
            'core__0104 down: artifact_revision_review_satisfaction is not empty; dropping it would destroy the record of which gate reviewed which revision. Export or delete the rows deliberately first.';
        END IF;
        DROP INDEX IF EXISTS artifact_revision_review_satisfaction_gate_idx;
        DROP TABLE artifact_revision_review_satisfaction;
      END IF;
    END
    $$;
  `);
  // See DOWN above: this FAILS on an instance that has already appended a
  // revision, and that is the correct outcome.
  pgm.sql(`
    ALTER TABLE artifact_produced_outbox DROP CONSTRAINT IF EXISTS artifact_produced_outbox_emitter_check;
    ALTER TABLE artifact_produced_outbox ADD CONSTRAINT artifact_produced_outbox_emitter_check
      CHECK (emitter IN ('createSemanticArtifact','dashboard_twin_writer','object_cms_snapshot_capture','object_snapshot_mint'));
  `);
}
