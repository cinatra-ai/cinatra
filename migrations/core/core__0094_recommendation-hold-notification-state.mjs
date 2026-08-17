// core__0094 — the recommendation hold's notification obligation, on the park row
// (cinatra#2835, Codex convergence round 3 finding 3) — the operator-upgrade twin
// of the fresh-install bootstrap DDL (`lifecycleInterceptionsSchemaQueries` in the
// already route-reachable src/lib/artifacts/artifact-review-gate-schema.ts, spread
// into buildCreateStoreSchemaQueries), shipped in the SAME PR.
//
// ONE CHANGE, PURELY ADDITIVE: `lifecycle_continuation_park.hold_notification`,
// a text column defaulting to 'none', plus its value CHECK and a PARTIAL index.
//
// WHY THE COLUMN EXISTS. A run-start recommendation hold mints a durable "needs
// your input" notification for the run's initiator, and that row must disappear
// the moment the park stops being `parked`. The park lives in this schema and is
// written through the agent-builder pg pool; the notification lives in
// `notifications` and is written through the host's own (synchronous, separate)
// connection. So "the delete commits with the status CAS" is not available — the
// two writes cannot share a transaction. What CAN share a transaction with each
// write is the park row itself:
//
//   enter  — the INSERT is fed from `SELECT … FOR UPDATE` of the park and this
//            column is set to 'live' beside it, one transaction, one connection.
//            The mark therefore never claims a row that was not written, and the
//            row lock serializes the write against the sweeper's `status =
//            'parked'` CAS (which is what closes the enter/clear TOCTOU).
//   clear  — the sweeper deletes the row and retires this column to 'cleared'
//            ONLY on an awaited, successful delete.
//
// "Park no longer `parked` AND hold_notification = 'live'" is thus a DURABLE,
// RETRYABLE clear obligation: a notifier failure or a dead process leaves work for
// the next sweep rather than a bell pointing forever at a card nobody can act on.
//
// NO DATA MOVES AND NOTHING IS RE-INTERPRETED. The column is new, so every
// pre-existing park row takes the 'none' default — which is the truthful value for
// them: no park that predates this migration ever had a notification written under
// the fenced write path, so none owes a clear. There is no backfill to get wrong
// and no emptiness tripwire to need (contrast core__0092, which changed a column's
// MEANING). Postgres 11+ applies a non-volatile DEFAULT as catalog metadata, so
// the ADD COLUMN does not rewrite the table.
//
// IDEMPOTENT: ADD COLUMN IF NOT EXISTS, an ADD CONSTRAINT wrapped in the
// duplicate_object guard (ADD CONSTRAINT has no IF NOT EXISTS), and CREATE INDEX
// IF NOT EXISTS. Statement for statement, in the same order, as the bootstrap
// twin. A re-run over an already-migrated schema is a no-op. Unqualified names
// ride the runner's search_path (the app schema). Metadata-only DDL plus one small
// PARTIAL index build; no noTransaction().
//
// SEQ 0094 — strictly greater than the max shipped seq on origin/main
// (core__0093). SEQ IS PROVISIONAL: a concurrent lane may claim 0094 first, in
// which case a rename-only renumber is normal (FLAGGED for the coordinator's
// train). migrations/** is HIGH-RISK: owner approval required; the lane never
// merges.
//
// DOWN. Drops the index, the constraint and the column. HONEST COST: an
// outstanding clear obligation recorded at the moment of the down is lost, so a
// hold notification whose park had already gone terminal but had not yet been
// cleared would survive as a stale row (its park is terminal, so nothing re-drives
// it). That window is the seconds between a sweep's CAS and its drain; the row
// remains hard-deletable by the ordinary per-run clear on any later status
// transition of that run. No park data is affected either way.

/** Idempotent DDL mirroring the bootstrap leaf STATEMENT FOR STATEMENT. */
export const holdNotificationStateDdlSql = `
  ALTER TABLE lifecycle_continuation_park
    ADD COLUMN IF NOT EXISTS hold_notification text NOT NULL DEFAULT 'none';

  DO $$ BEGIN
    ALTER TABLE lifecycle_continuation_park
      ADD CONSTRAINT lifecycle_continuation_park_hold_notification_chk
      CHECK (hold_notification IN ('none','live','cleared'));
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$;

  CREATE INDEX IF NOT EXISTS lifecycle_continuation_park_hold_notify_idx
    ON lifecycle_continuation_park (hold_notification, status)
    WHERE hold_notification = 'live';
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(holdNotificationStateDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`
    DROP INDEX IF EXISTS lifecycle_continuation_park_hold_notify_idx;
    ALTER TABLE lifecycle_continuation_park
      DROP CONSTRAINT IF EXISTS lifecycle_continuation_park_hold_notification_chk;
    ALTER TABLE lifecycle_continuation_park
      DROP COLUMN IF EXISTS hold_notification;
  `);
}
