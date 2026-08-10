// core__0092 — chat-hitl S6b: suggestion decisions inside the gate CAS
// (cinatra#2571, epic #2564) — the operator-upgrade twin of the fresh-install
// bootstrap DDL (suggestionDecisionCasSchemaQueries) co-located in the already
// route-reachable src/lib/artifacts/artifact-review-gate-schema.ts and spread into
// buildCreateStoreSchemaQueries in the SAME PR.
//
// TWO CHANGES.
//
//   suggestion_decision_ledger — RESHAPED from "one row per SNAPSHOT" to "one row
//     per DECIDED SUGGESTION". As shipped by core__0079, `suggestion_id`
//     REFERENCED gate_suggestion_snapshots(id) and was UNIQUE, which admits
//     exactly one ledger row per snapshot row. A snapshot is a single row carrying
//     MANY suggestions, so that shape cannot record an accepted/dismissed
//     partition at all — the defect #2571 names. After this migration
//     `suggestion_id` is the id of a suggestion INSIDE the payload, `snapshot_id`
//     carries the FK that used to sit on it, `decision_fingerprint` binds each row
//     to the ONE review decision that wrote it, and `applied_at` is the
//     exactly-once CAS predicate the application drain stamps.
//
//   suggestion_application_outbox — NEW. The durable application-intent channel,
//     deliberately shaped like artifact_review_resume_outbox (lease + attempts +
//     max_attempts + dead_lettered_at + last_error) because it carries the same
//     contract: persisted EXACTLY ONCE inside the gate-CAS transaction, drained
//     AT-LEAST-ONCE against an idempotent consumer. PK gate_id ⇒ at most one
//     application intent per gate.
//
// THE RESHAPE MOVES NO DATA, AND PROVES IT RATHER THAN ASSUMING IT. The ledger
// shipped in core__0079 with a reader and NO writer in any release (the same
// gap #2570 closed on gate_suggestion_snapshots), so every deployment's table is
// empty. `suggestion_id` changes MEANING here, so a silent reshape over a
// non-empty table would re-interpret existing rows as suggestion ids that name
// nothing. The migration therefore RAISES on a non-empty table instead: an
// operator who somehow has rows gets a loud stop and a conversation, never a
// quietly corrupted decision record.
//
// ADDITIVE + IDEMPOTENT otherwise — every statement is IF EXISTS / IF NOT EXISTS
// and mirrors the bootstrap leaf exactly (same statements, SAME ORDER: the
// additive steps and the NOT NULL tripwire run before anything destructive, so a
// table that unexpectedly holds rows fails with its original constraints intact
// instead of half-reshaped). A re-run over an ALREADY-reshaped table is a no-op,
// guard included — the guard returns early once `snapshot_id` exists. Unqualified names ride the runner's search_path (the app
// schema). Metadata-only DDL over an empty table plus one CREATE TABLE; no
// noTransaction().
//
// SEQ 0092 — strictly greater than the max shipped seq on origin/main
// (core__0091). SEQ IS PROVISIONAL: a concurrent lane may claim 0092 first, in
// which case a rename-only renumber is normal (FLAGGED for the coordinator's
// train). migrations/** is HIGH-RISK: owner approval required; the lane never
// merges.
//
// DOWN. Drops the outbox and reverts the ledger to its core__0079 shape. HONEST
// COST: a --down over a schema that has recorded suggestion decisions loses them
// (and would fail the restored UNIQUE(suggestion_id) if two rows share a
// suggestion id), so the down path drops the ledger rows first — the same posture
// core__0081's down takes with the repair tables.

/**
 * The emptiness proof, CONDITIONAL ON THE OLD SHAPE (Codex round 1, finding 4).
 *
 * `suggestion_id` changes meaning, so legacy rows are a STOP, not a backfill. But
 * the check must only fire while the table still HAS the legacy shape: once the
 * reshape has landed, rows are legitimate decision records and a re-run of this
 * migration must be a no-op, not an exception. `snapshot_id` existing is exactly
 * the "already reshaped" witness.
 */
export const ledgerEmptinessGuardSql = `
  DO $$
  DECLARE
    row_count bigint;
  BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'suggestion_decision_ledger'
         AND column_name = 'snapshot_id'
         AND table_schema = current_schema()
    ) THEN
      RETURN; -- already reshaped: its rows are real decisions, not legacy rows.
    END IF;
    SELECT count(*) INTO row_count FROM suggestion_decision_ledger;
    IF row_count > 0 THEN
      RAISE EXCEPTION
        'core__0092: suggestion_decision_ledger holds % row(s) in its pre-migration shape. This migration re-interprets suggestion_id (snapshot row id -> in-payload suggestion id) and refuses to do that under existing rows. The table shipped with no writer in any release, so rows here need an explicit decision before upgrading.',
        row_count;
    END IF;
  END $$;
`;

/**
 * Idempotent DDL mirroring the bootstrap leaf STATEMENT FOR STATEMENT — including
 * the order, which is itself the safety property (see the twin's comment): the
 * additive steps and the NOT NULL tripwire run BEFORE anything destructive, so a
 * table that unexpectedly holds rows fails with all of its original constraints
 * intact rather than half-reshaped.
 */
export const suggestionDecisionCasDdlSql = `
  -- Additive first...
  ALTER TABLE suggestion_decision_ledger ADD COLUMN IF NOT EXISTS snapshot_id text;
  ALTER TABLE suggestion_decision_ledger ADD COLUMN IF NOT EXISTS decision_fingerprint text;
  ALTER TABLE suggestion_decision_ledger ADD COLUMN IF NOT EXISTS applied_at timestamptz;
  -- ...then the tripwire (raises on legacy rows, before any drop)...
  ALTER TABLE suggestion_decision_ledger ALTER COLUMN snapshot_id SET NOT NULL;
  ALTER TABLE suggestion_decision_ledger ALTER COLUMN decision_fingerprint SET NOT NULL;

  -- ...then the one-row-per-snapshot constraints go...
  ALTER TABLE suggestion_decision_ledger DROP CONSTRAINT IF EXISTS suggestion_decision_ledger_uniq;
  DROP INDEX IF EXISTS suggestion_decision_ledger_uniq;
  ALTER TABLE suggestion_decision_ledger DROP CONSTRAINT IF EXISTS suggestion_decision_ledger_suggestion_id_fkey;

  -- ...the foreign keys are re-pointed (DROP IF EXISTS + ADD, mirroring the twin)...
  ALTER TABLE suggestion_decision_ledger DROP CONSTRAINT IF EXISTS suggestion_decision_ledger_snapshot_id_fkey;
  ALTER TABLE suggestion_decision_ledger ADD CONSTRAINT suggestion_decision_ledger_snapshot_id_fkey
    FOREIGN KEY (snapshot_id) REFERENCES gate_suggestion_snapshots (id) ON DELETE CASCADE;
  ALTER TABLE suggestion_decision_ledger DROP CONSTRAINT IF EXISTS suggestion_decision_ledger_gate_id_fkey;
  ALTER TABLE suggestion_decision_ledger ADD CONSTRAINT suggestion_decision_ledger_gate_id_fkey
    FOREIGN KEY (gate_id) REFERENCES artifact_review_gates (id) ON DELETE CASCADE;

  -- ...and uniqueness is re-asserted PER ITEM.
  CREATE UNIQUE INDEX IF NOT EXISTS suggestion_decision_ledger_uniq
    ON suggestion_decision_ledger (snapshot_id, suggestion_id);
  CREATE INDEX IF NOT EXISTS suggestion_decision_ledger_gate_idx
    ON suggestion_decision_ledger (gate_id);

  CREATE TABLE IF NOT EXISTS suggestion_application_outbox (
    gate_id              text PRIMARY KEY REFERENCES artifact_review_gates (id) ON DELETE CASCADE,
    run_id               text NOT NULL,
    review_task_id       text NOT NULL,
    snapshot_id          text NOT NULL REFERENCES gate_suggestion_snapshots (id) ON DELETE CASCADE,
    decision_fingerprint text NOT NULL,
    accepted_ids         jsonb NOT NULL,
    status               text NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','delivering','done')),
    attempts             integer NOT NULL DEFAULT 0,
    max_attempts         integer NOT NULL DEFAULT 20,
    lease_token          text,
    lease_expires_at     timestamptz,
    dead_lettered_at     timestamptz,
    last_error           text,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS suggestion_application_outbox_status_idx
    ON suggestion_application_outbox (status, created_at);
  CREATE INDEX IF NOT EXISTS suggestion_application_outbox_dead_idx
    ON suggestion_application_outbox (dead_lettered_at) WHERE dead_lettered_at IS NOT NULL;
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(ledgerEmptinessGuardSql);
  pgm.sql(suggestionDecisionCasDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Revert to the core__0079 shape. HONEST COST: recorded suggestion decisions are
  // lost (the rows are deleted first, because the restored UNIQUE(suggestion_id)
  // cannot hold two decisions that share an in-payload suggestion id, and because
  // the restored FK expects suggestion_id to name a SNAPSHOT ROW).
  pgm.sql(`
    DROP TABLE IF EXISTS suggestion_application_outbox;

    DELETE FROM suggestion_decision_ledger;
    DROP INDEX IF EXISTS suggestion_decision_ledger_uniq;
    DROP INDEX IF EXISTS suggestion_decision_ledger_gate_idx;
    ALTER TABLE suggestion_decision_ledger DROP CONSTRAINT IF EXISTS suggestion_decision_ledger_snapshot_id_fkey;
    ALTER TABLE suggestion_decision_ledger DROP CONSTRAINT IF EXISTS suggestion_decision_ledger_gate_id_fkey;
    ALTER TABLE suggestion_decision_ledger DROP COLUMN IF EXISTS applied_at;
    ALTER TABLE suggestion_decision_ledger DROP COLUMN IF EXISTS decision_fingerprint;
    ALTER TABLE suggestion_decision_ledger DROP COLUMN IF EXISTS snapshot_id;
    ALTER TABLE suggestion_decision_ledger
      ADD CONSTRAINT suggestion_decision_ledger_suggestion_id_fkey
      FOREIGN KEY (suggestion_id) REFERENCES gate_suggestion_snapshots (id) ON DELETE CASCADE;
    ALTER TABLE suggestion_decision_ledger
      ADD CONSTRAINT suggestion_decision_ledger_uniq UNIQUE (suggestion_id);
  `);
}
