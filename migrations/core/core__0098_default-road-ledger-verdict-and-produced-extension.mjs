// core__0098 — the default road's data (cinatra#3029, epic #3023 W5).
//
// The operator-upgrade twin of four fresh-install bootstrap edits landing in the
// SAME pull request:
//   * `artifact_materializations` in src/lib/drizzle-store.ts,
//   * `artifact_produced_outbox` in src/lib/artifacts/artifact-review-gate-schema.ts,
//   * `artifact_detection_settings` in src/lib/drizzle-store.ts,
//   * `agent_run_output_derivations` in packages/agents/src/schema.ts.
//
// WHY. Until this slice an agent's output that no binding named was ADVISED and
// DROPPED: the post-terminal job read only the run's final response text, typed
// it against the agent's declared produces, and otherwise emitted an "Agent
// output not captured" notice. After it, every end-node output at or above the
// one-kilobyte document floor is typed by a ladder and written as an artifact.
// The four changes below are what that road needs to be READABLE afterwards.
//
// 1. `artifact_materializations.path` gains `'default_road'`, and every row the
//    pickup writes carries `decided_rung` + `decided_verdict` — "the rung that
//    decided the form and the verdict it decided on (the detected form, the
//    model's answer and confidence where the model rung ran)" (plan §8.2). The
//    widening is GUARDED exactly as core__0071's was: it re-asserts the named
//    CHECK only when it is absent or lacks the value, and no existing row can
//    carry it, so it never rejects. The two columns are nullable ADDs — every
//    row written by the four older paths keeps NULL, which reads correctly as
//    "no ladder ran on this row".
//
// 2. `artifact_produced_outbox` gains `producing_extension` +
//    `producing_extension_version` — "the produced event [...] gains the
//    producing extension and its pinned version beside the run" (plan §8.2).
//    Nullable ADDs; every existing event keeps NULL, which reads as "the
//    emitter did not record one", not as a wrong value.
//
// 3. `artifact_detection_settings` is the model rung's PER-ORGANISATION SWITCH
//    (item 0.18: "a per-organisation switch that turns the rung off and yields
//    plain text"). One row per organisation, absent ⇒ ON, so a fresh instance
//    and an upgraded one behave identically and nothing has to be backfilled.
//
// 4. `agent_run_output_derivations` gains `items jsonb`, and `content` +
//    `content_hash` lose their NOT NULL. The row is still ONE per run — the
//    durable outbox the terminal transition writes inside its own guarded
//    transaction — but it now carries the FAMILY of end-node outputs at or
//    above the floor instead of the single final-text snapshot. Dropping the
//    two NOT NULLs is what lets the response-text capture RETIRE rather than be
//    written and then ignored: a run captured after this migration writes
//    `items` and leaves `content` NULL. A `pending` row captured BEFORE it
//    still carries `content` and no `items`, and the drain settles exactly such
//    a row `done` without writing an artifact — response text takes no road.
//
// ADDITIVE by the convention's enumeration (migrations/README.md): three
// nullable ADD COLUMNs, one CREATE TABLE IF NOT EXISTS, one guarded CHECK
// WIDENING, and two DROP NOT NULLs. Nothing is rewritten, nothing is deleted,
// and every value the old constraints admitted is still admitted.
//
// SEQ 0098 — strictly greater than the max shipped seq on the base branch
// (core__0097 artifact-review-audit-first-party-renderer-kind). migrations/**
// is HIGH-RISK: owner approval required; the lane never merges.
//
// DOWN. Narrows the path CHECK back to the core__0071 vocabulary when no
// `default_road` row exists (a NOTICE and no narrowing when one does — the same
// honest refusal core__0071's own down() makes), drops the four added columns,
// drops the settings table, and restores the two NOT NULLs. HONEST COST: the
// two NOT NULL restores FAIL on an instance that has captured an
// items-carrying outbox row whose `content` is NULL. That is the correct
// failure — inventing a content value to make a revert succeed would fabricate
// a capture that never happened.
//
// Unqualified names ride the runner's search_path (the app schema), matching
// every sibling module in this chain.

/** Idempotent DDL mirroring the bootstrap leaves — safe to run after them, and a no-op on any database the bootstrap has already created wide. */
export const defaultRoadDdlSql = `
  DO $dr_path$
  DECLARE def text;
  BEGIN
    SELECT pg_get_constraintdef(c.oid) INTO def
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE c.conname = 'artifact_materializations_path_check'
       AND t.relname = 'artifact_materializations'
       AND n.nspname = current_schema();
    IF def IS NULL THEN
      ALTER TABLE artifact_materializations DROP CONSTRAINT IF EXISTS artifact_materializations_path_check;
      ALTER TABLE artifact_materializations
        ADD CONSTRAINT artifact_materializations_path_check
        CHECK (path IN ('end_node_binding','materialize_tool','llm_emit','derived_output','default_road'));
    ELSIF position('default_road' IN def) = 0 THEN
      ALTER TABLE artifact_materializations DROP CONSTRAINT artifact_materializations_path_check;
      ALTER TABLE artifact_materializations
        ADD CONSTRAINT artifact_materializations_path_check
        CHECK (path IN ('end_node_binding','materialize_tool','llm_emit','derived_output','default_road'));
    END IF;
  END $dr_path$;

  ALTER TABLE artifact_materializations ADD COLUMN IF NOT EXISTS decided_rung text;
  ALTER TABLE artifact_materializations ADD COLUMN IF NOT EXISTS decided_verdict jsonb;

  ALTER TABLE artifact_produced_outbox ADD COLUMN IF NOT EXISTS producing_extension text;
  ALTER TABLE artifact_produced_outbox ADD COLUMN IF NOT EXISTS producing_extension_version text;

  CREATE TABLE IF NOT EXISTS artifact_detection_settings (
    org_id             text PRIMARY KEY,
    model_rung_enabled boolean NOT NULL DEFAULT true,
    updated_at         timestamptz NOT NULL DEFAULT now()
  );

  ALTER TABLE agent_run_output_derivations ADD COLUMN IF NOT EXISTS items jsonb;
  ALTER TABLE agent_run_output_derivations ALTER COLUMN content DROP NOT NULL;
  ALTER TABLE agent_run_output_derivations ALTER COLUMN content_hash DROP NOT NULL;
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(defaultRoadDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // See DOWN above: the two NOT NULL restores FAIL on an instance that has
  // captured an items-carrying outbox row, and that is the correct outcome.
  pgm.sql(`
    DROP TABLE IF EXISTS artifact_detection_settings;
    ALTER TABLE artifact_produced_outbox DROP COLUMN IF EXISTS producing_extension_version;
    ALTER TABLE artifact_produced_outbox DROP COLUMN IF EXISTS producing_extension;
    ALTER TABLE artifact_materializations DROP COLUMN IF EXISTS decided_verdict;
    ALTER TABLE artifact_materializations DROP COLUMN IF EXISTS decided_rung;
    ALTER TABLE agent_run_output_derivations DROP COLUMN IF EXISTS items;
    ALTER TABLE agent_run_output_derivations ALTER COLUMN content SET NOT NULL;
    ALTER TABLE agent_run_output_derivations ALTER COLUMN content_hash SET NOT NULL;
    DO $dr_path_down$
    BEGIN
      IF EXISTS (SELECT 1 FROM artifact_materializations WHERE path = 'default_road') THEN
        RAISE NOTICE 'core__0098 down(): default_road ledger rows exist; leaving artifact_materializations_path_check widened. Archive/migrate those rows manually to narrow it.';
      ELSE
        ALTER TABLE artifact_materializations DROP CONSTRAINT IF EXISTS artifact_materializations_path_check;
        ALTER TABLE artifact_materializations
          ADD CONSTRAINT artifact_materializations_path_check
          CHECK (path IN ('end_node_binding','materialize_tool','llm_emit','derived_output'));
      END IF;
    END $dr_path_down$;
  `);
}
