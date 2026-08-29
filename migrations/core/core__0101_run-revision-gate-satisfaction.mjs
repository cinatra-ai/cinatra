// core__0101 — the mid-run revision's data (cinatra#3030, epic #3023 W6).
//
// The operator-upgrade twin of two fresh-install bootstrap edits landing in the
// SAME pull request, both in `src/lib/artifacts/artifact-review-gate-schema.ts`:
// the `artifact_produced_outbox.emitter` vocabulary and the new
// `artifact_revision_review_satisfaction` table.
//
// WHY. Item 0.30: "a mid-run write may name an existing artifact and append its
// next revision instead of creating a new one — a compare-and-set against the
// revision the caller read, the same ledger row and produced event [...] The
// append's produced event carries the live-generator origin, which the review
// policy maps to intermediate and skips by default; because an organisation-
// required review or a per-run elevation can still fire it, the caller's own
// declared gate is recorded as the review of those revisions, and the
// produced-output road, when it fires, resolves to that gate instead of opening
// a second — a satisfaction rule keyed on the artifact revision and the run, new
// machinery this item names."
//
// 1. `artifact_produced_outbox.emitter` gains `'artifact_revision_append'`. The
//    append is a produced-event choke point of its own — the enumerated set is
//    what makes the choke points auditable, so a new one is DECLARED rather than
//    smuggled under an existing name. The widening is GUARDED the way core__0099's
//    path widening is: the named CHECK is re-asserted only when it is absent or
//    lacks the value, and no existing row can carry it, so it never rejects.
//
// 2. `artifact_revision_review_satisfaction` records, per appended revision, the
//    run that appended it and the review task id of the gate that run declared.
//    Keyed on (organisation, artifact, revision) so one revision names exactly
//    one satisfying gate — "one review per artifact, one reference per gate".
//    Nothing is backfilled: a revision written before this migration names no
//    gate, which reads correctly as "the produced-output road decides on its
//    own", exactly as it does today.
//
// SHAPE: one guarded CHECK widening and one CREATE TABLE IF NOT EXISTS with one
// index. Nothing is rewritten, nothing is deleted, and every value the old
// constraint admitted is still admitted. Recorded as destructive because the
// convention's classifier enumerates ADD CONSTRAINT over existing rows as such.
//
// DOWN narrows the emitter CHECK back when no append event exists (a NOTICE and
// no narrowing when one does — the honest refusal core__0099's own down() makes)
// and drops the satisfaction table.
//
// SEQ 0101 — 0099 and 0100 are spoken for by the two sibling slices of this epic
// that are in flight against the same base (whichever lands second renumbers to
// 0100), so this slice takes the next free number above both.
//
// Unqualified names ride the runner's search_path (the app schema), matching
// every sibling module in this chain.

/** Idempotent DDL mirroring the bootstrap leaves — safe to run after them, and a no-op on any database the bootstrap has already created wide. */
export const revisionGateSatisfactionDdlSql = `
  DO $rev_emitter$
  DECLARE def text;
  BEGIN
    SELECT pg_get_constraintdef(c.oid) INTO def
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE c.conname = 'artifact_produced_outbox_emitter_check'
       AND t.relname = 'artifact_produced_outbox'
       AND n.nspname = current_schema();
    IF def IS NULL THEN
      ALTER TABLE artifact_produced_outbox DROP CONSTRAINT IF EXISTS artifact_produced_outbox_emitter_check;
      ALTER TABLE artifact_produced_outbox
        ADD CONSTRAINT artifact_produced_outbox_emitter_check
        CHECK (emitter IN ('createSemanticArtifact','dashboard_twin_writer','object_cms_snapshot_capture','artifact_revision_append'));
    ELSIF position('artifact_revision_append' IN def) = 0 THEN
      ALTER TABLE artifact_produced_outbox DROP CONSTRAINT artifact_produced_outbox_emitter_check;
      ALTER TABLE artifact_produced_outbox
        ADD CONSTRAINT artifact_produced_outbox_emitter_check
        CHECK (emitter IN ('createSemanticArtifact','dashboard_twin_writer','object_cms_snapshot_capture','artifact_revision_append'));
    END IF;
  END $rev_emitter$;

  CREATE TABLE IF NOT EXISTS artifact_revision_review_satisfaction (
    org_id                     text NOT NULL,
    artifact_id                text NOT NULL,
    representation_revision_id text NOT NULL,
    run_id                     text NOT NULL,
    review_task_id             text NOT NULL,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, artifact_id, representation_revision_id)
  );

  CREATE INDEX IF NOT EXISTS artifact_revision_review_satisfaction_run_idx
    ON artifact_revision_review_satisfaction (org_id, run_id);
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(revisionGateSatisfactionDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`
    DO $rev_sat_down$
    BEGIN
      IF to_regclass('artifact_revision_review_satisfaction') IS NULL THEN
        RAISE NOTICE 'core__0101 down(): artifact_revision_review_satisfaction is already absent.';
      ELSIF EXISTS (SELECT 1 FROM artifact_revision_review_satisfaction) THEN
        -- The rows record WHICH GATE reviewed an appended revision. Dropping
        -- them destroys review provenance that nothing else carries, so the
        -- rollback refuses rather than deletes -- the same honest refusal the
        -- emitter narrowing below makes.
        RAISE NOTICE 'core__0101 down(): artifact_revision_review_satisfaction has rows; leaving the table in place. Archive those rows manually to drop it.';
      ELSE
        DROP TABLE artifact_revision_review_satisfaction;
      END IF;
    END $rev_sat_down$;
    DO $rev_emitter_down$
    BEGIN
      IF EXISTS (SELECT 1 FROM artifact_produced_outbox WHERE emitter = 'artifact_revision_append') THEN
        RAISE NOTICE 'core__0101 down(): artifact_revision_append events exist; leaving the emitter check widened. Archive those rows manually to narrow it.';
      ELSE
        ALTER TABLE artifact_produced_outbox DROP CONSTRAINT IF EXISTS artifact_produced_outbox_emitter_check;
        ALTER TABLE artifact_produced_outbox
          ADD CONSTRAINT artifact_produced_outbox_emitter_check
          CHECK (emitter IN ('createSemanticArtifact','dashboard_twin_writer','object_cms_snapshot_capture'));
      END IF;
    END $rev_emitter_down$;
  `);
}
