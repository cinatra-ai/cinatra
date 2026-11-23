// core__0133 — the publish decision's own row declaration on
// `agent_run_publish_decisions` (cinatra#4150).
// Operator-upgrade twin of the fresh-install bootstrap DDL
// (`publishDecisionSchemaQueries` in src/lib/artifacts/publication-operation-schema.ts),
// shipped in the SAME change (the core__0130 precedent).
//
// WHAT. ONE additive nullable column, `declared_rows` (text, JSON-as-text like
// `surfaced_values`): the rows the template declared for the decision's node
// when the run parked there, `[{ label, input }]`. The publish card draws a
// decision's rows from it, so a recompile that changes the template's
// `publish_rows` later never relabels a decision already surfaced. null = not
// recorded: a row written before this column existed, or a park whose template
// could not be read; the card then falls back to the template's current rows.
//
// TWO MORE ADDITIVE NULLABLE COLUMNS for the same decision record:
//   - `agent_run_publish_decisions.superseded_at` (timestamptz): set by a retry's
//     reset for every decision of the failed attempt, so a closed decision of an
//     earlier attempt never holds a later attempt's gate. null = the run's
//     current attempt.
//   - `agent_runs.dispatch_publish_rows` (text, JSON-as-text): the publish rows
//     map of the template object the worker dispatched the run's current attempt
//     with (the queued -> running CAS writes it). The park copies its node's
//     rows from here, so a recompile between dispatch and park never relabels
//     the decision. null = not recorded.
//
// NO BACKFILL AND NO STORED VALUE CHANGES. No default, no constraint: every
// existing row reads NULL. The schema-migration gate classifies this
// NON-destructive.
//
// LOCKS. Each column add is catalog-only (nullable, no default: no rewrite and
// no scan), so its ACCESS EXCLUSIVE lock is held for milliseconds once granted.
//
// LOCK WAIT. As core__0130: `up` runs outside a transaction and sets
// lock_timeout = DECLARED_ROWS_LOCK_TIMEOUT_MS on its session first and resets
// it last, so an ALTER that waits behind a long reader fails (55P03) instead of
// queueing the application's statements behind it. The migration then stops
// with no ledger row, and the next run replays it.
//
// IDEMPOTENT. ADD COLUMN IF NOT EXISTS: a replay, or a run after the bootstrap
// leaf, changes nothing.
//
// DOWN drops the three columns and what they hold; the card then falls back
// to the template's current rows, and every decision reads as its run's
// current attempt again. Safe only once no deployed code
// reads the columns.
//
// SEQ 0133: 0132 is the highest sequence on main (2026-11-23). A rename-only
// renumber at merge is normal. Unqualified names ride the runner's search_path
// (the app schema).

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it. */
export const publishDecisionDeclaredRowsDdlSql = `ALTER TABLE agent_run_publish_decisions ADD COLUMN IF NOT EXISTS declared_rows text`;

/** A statement of `down`: each removes only what `up` added. */
export const publishDecisionDeclaredRowsDownSql = `ALTER TABLE agent_run_publish_decisions DROP COLUMN IF EXISTS declared_rows`;

/** The attempt marker of a decision (TWO MORE COLUMNS above), idempotent like the bootstrap leaf. */
export const publishDecisionSupersededAtDdlSql = `ALTER TABLE agent_run_publish_decisions ADD COLUMN IF NOT EXISTS superseded_at timestamptz`;
export const publishDecisionSupersededAtDownSql = `ALTER TABLE agent_run_publish_decisions DROP COLUMN IF EXISTS superseded_at`;

/** The dispatched publish rows of a run (TWO MORE COLUMNS above), idempotent like the bootstrap line. */
export const runDispatchPublishRowsDdlSql = `ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS dispatch_publish_rows text`;
export const runDispatchPublishRowsDownSql = `ALTER TABLE agent_runs DROP COLUMN IF EXISTS dispatch_publish_rows`;

/** The longest wait for the lock `up` takes (LOCK WAIT above), in ms. */
export const DECLARED_ROWS_LOCK_TIMEOUT_MS = 5_000;

/** @param {Pick<import("node-pg-migrate").MigrationBuilder, "sql" | "noTransaction">} pgm */
export function up(pgm) {
  // One autocommit statement each; the lock_timeout is the session's, so it
  // binds the ALTER between the SET and the RESET.
  pgm.noTransaction();
  pgm.sql(`SET lock_timeout = ${DECLARED_ROWS_LOCK_TIMEOUT_MS}`);
  pgm.sql(publishDecisionDeclaredRowsDdlSql);
  pgm.sql(publishDecisionSupersededAtDdlSql);
  pgm.sql(runDispatchPublishRowsDdlSql);
  pgm.sql("RESET lock_timeout");
}

/** @param {Pick<import("node-pg-migrate").MigrationBuilder, "sql">} pgm */
export function down(pgm) {
  pgm.sql(runDispatchPublishRowsDownSql);
  pgm.sql(publishDecisionSupersededAtDownSql);
  pgm.sql(publishDecisionDeclaredRowsDownSql);
}
