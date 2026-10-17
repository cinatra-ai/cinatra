// core__0113 — the whole answer of a context-slot finalize (cinatra#3080).
// The operator-upgrade twin of the fresh-install bootstrap DDL
// (`runContextAnswersSchemaQueries` in src/lib/artifact-claim-schema.ts,
// added in the SAME pull request) — the two halves ship together, the
// core__0095 / core__0104 precedent.
//
// WHY. `run_context_selections` gives every selected ref its own
// content-addressed id and inserts it ON CONFLICT DO NOTHING, so its rows are
// the set of refs a run EVER picked for a slot. A correction that removes a
// ref, or clears the slot, leaves no trace there, and an answer of nothing
// leaves no row at all — so nothing on the database said what a run's answer
// to a slot IS. Finalize now appends ONE `run_context_answers` row per
// finalize of a slot, holding the complete ordered ref set (an empty set
// included), in the same transaction as the audit rows and the retention
// pins. The latest answer is the greatest `answer_seq` for (org, run, slot):
// a per-slot sequence assigned under a transaction-scoped advisory lock and
// UNIQUE per (org, run, slot), never a clock.
//
// ADDITIVE ONLY. A brand-new table, its unique index and its append-only
// trigger. No existing table is touched and no existing row is read or
// rewritten. NOTHING IS BACKFILLED: a run finalized before this table existed
// has no answer row, and the reader keeps treating such a run exactly as it
// did before (it inherits only the empty answer the audit rows can prove).
// Deriving answer rows from the audit rows would record whole answers those
// rows cannot prove.
//
// SEQ 0113 — 0111 is the highest sequence on main at authoring time and 0112
// is claimed by another open change, so this takes the next free one.
//
// DOWN refuses to destroy recorded answers (the core__0104 precedent): the
// table is dropped only when it is empty.
//
// Unqualified names ride the runner's search_path (the app schema), matching
// every sibling module in this chain.

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it. */
export const runContextAnswersDdlSql = `
  CREATE TABLE IF NOT EXISTS run_context_answers (
    id                   text PRIMARY KEY,
    org_id               text NOT NULL,
    parent_run_id        text NOT NULL,
    parent_package_name  text NOT NULL,
    slot_id              text NOT NULL,
    answer_seq           integer NOT NULL,
    refs                 jsonb NOT NULL,
    selected_by          text NOT NULL,
    selection_mode       text NOT NULL,
    answered_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT rca_seq_chk CHECK (answer_seq >= 1),
    CONSTRAINT rca_refs_chk CHECK (jsonb_typeof(refs) = 'array'),
    CONSTRAINT rca_selectedby_chk CHECK (selected_by IN ('user','agent','autonomous')),
    CONSTRAINT rca_selmode_chk CHECK (selection_mode IN ('interactive','autonomous'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS rca_run_slot_seq_idx
    ON run_context_answers (org_id, parent_run_id, slot_id, answer_seq);
  CREATE OR REPLACE FUNCTION fn_run_context_answers_append_only() RETURNS trigger LANGUAGE plpgsql AS $body$
  BEGIN
    RAISE EXCEPTION 'run_context_answers is append-only: % forbidden — a later finalize appends a NEW answer', TG_OP;
  END;
  $body$;
  DROP TRIGGER IF EXISTS trg_run_context_answers_append_only ON run_context_answers;
  CREATE TRIGGER trg_run_context_answers_append_only BEFORE UPDATE OR DELETE ON run_context_answers FOR EACH ROW EXECUTE FUNCTION fn_run_context_answers_append_only();
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(runContextAnswersDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // The table goes ONLY when it holds nothing. A row here is the record of
  // which context a run answered a slot with; a revert that erases it leaves
  // every later repair of that run without the answer it would inherit.
  pgm.sql(`
    DO $$
    BEGIN
      IF to_regclass('run_context_answers') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM run_context_answers) THEN
          RAISE EXCEPTION
            'core__0113 down: run_context_answers is not empty; dropping it would destroy the record of which context each run answered. Export or delete the rows deliberately first.';
        END IF;
        DROP TABLE run_context_answers;
      END IF;
    END
    $$;
    DROP FUNCTION IF EXISTS fn_run_context_answers_append_only();
  `);
}
