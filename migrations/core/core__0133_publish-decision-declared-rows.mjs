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
// THREE MORE COLUMNS for the same decision record:
//   - `agent_runs.reset_generation` (integer NOT NULL DEFAULT 0): a retry's
//     reset (failed -> pending_input) raises it by 1 in its compare-and-set, so
//     each attempt a reset starts has its own number. Every existing run reads 0.
//   - `agent_run_publish_decisions.run_generation` (integer, nullable): the
//     run's reset_generation at the park. A decision belongs to the run's
//     current attempt only while the two are equal; a closed decision of an
//     earlier attempt never holds a later attempt's gate. null = a row written
//     by code older than the column, read as generation 0.
//   - `agent_runs.dispatch_publish_rows` (text, JSON-as-text): the publish rows
//     map of the template object the worker dispatched the run's current attempt
//     with (the queued -> running CAS writes it). The park copies its node's
//     rows from here, so a recompile between dispatch and park never relabels
//     the decision. null = not recorded.
//
// BACKFILL (run_generation only, rows still NULL only). A reset before this
// migration ended its attempt without any mark, so each existing decision is
// classified once:
//   run_generation = the run's reset_generation (current) when the run row
//     exists, the run is not in pending_input, and the run's current attempt
//     started no later than the decision (started_at IS NULL, or
//     created_at >= started_at);
//   run_generation = -1 (an ended attempt) otherwise.
// Why: started_at is the current attempt's first dispatch; the queued ->
// running CAS keeps it (COALESCE) and only a reset clears it, so a decision
// older than it belongs to an attempt a reset ended. A run in pending_input
// holds no publish gate: it waits for its inputs, and its next dispatch is a
// fresh attempt. A run whose started_at is NULL in any other status (a run
// dispatched before the stamp existed) keeps its decisions current: a declined
// or open decision of a stopped or held run must still hold its resume.
// No other column and no other stored value changes.
//
// The schema-migration gate counts a NOT NULL column added to an existing
// table, and the backfill, as user-land-affecting, so the manifest marks this
// migration destructive (the core__0126 precedent); no stored value is lost.
//
// LOCKS. Each column add is catalog-only (nullable, or a constant default: no
// rewrite and no scan), so its ACCESS EXCLUSIVE lock is held for milliseconds
// once granted. The backfill is one UPDATE of the decision rows still NULL.
//
// LOCK WAIT. As core__0130: `up` runs outside a transaction and sets
// lock_timeout = DECLARED_ROWS_LOCK_TIMEOUT_MS on its session first and resets
// it last, so an ALTER that waits behind a long reader fails (55P03) instead of
// queueing the application's statements behind it. The migration then stops
// with no ledger row, and the next run replays it.
//
// IDEMPOTENT. ADD COLUMN IF NOT EXISTS, and the backfill touches only rows
// whose run_generation is still NULL: a replay changes nothing. A run after the
// bootstrap leaf (which adds the columns without a backfill) still classifies
// the existing rows.
//
// DOWN drops the four columns and what they hold; the card then falls back
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

/** The attempt marker of a run and of a decision (THREE MORE COLUMNS above), idempotent like the bootstrap lines. */
export const runResetGenerationDdlSql = `ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS reset_generation integer NOT NULL DEFAULT 0`;
export const runResetGenerationDownSql = `ALTER TABLE agent_runs DROP COLUMN IF EXISTS reset_generation`;
export const publishDecisionRunGenerationDdlSql = `ALTER TABLE agent_run_publish_decisions ADD COLUMN IF NOT EXISTS run_generation integer`;
export const publishDecisionRunGenerationDownSql = `ALTER TABLE agent_run_publish_decisions DROP COLUMN IF EXISTS run_generation`;

/** The BACKFILL above: each decision still NULL is classified once; a replay finds no NULL row. */
export const publishDecisionRunGenerationBackfillSql = `UPDATE agent_run_publish_decisions AS d
   SET run_generation = COALESCE(
         (SELECT r.reset_generation FROM agent_runs AS r
           WHERE r.id = d.run_id
             AND r.status <> 'pending_input'
             AND (r.started_at IS NULL OR d.created_at >= r.started_at)),
         -1)
 WHERE d.run_generation IS NULL`;

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
  pgm.sql(runResetGenerationDdlSql);
  pgm.sql(publishDecisionRunGenerationDdlSql);
  pgm.sql(runDispatchPublishRowsDdlSql);
  pgm.sql("RESET lock_timeout");
  pgm.sql(publishDecisionRunGenerationBackfillSql);
}

/** @param {Pick<import("node-pg-migrate").MigrationBuilder, "sql">} pgm */
export function down(pgm) {
  pgm.sql(runDispatchPublishRowsDownSql);
  pgm.sql(publishDecisionRunGenerationDownSql);
  pgm.sql(runResetGenerationDownSql);
  pgm.sql(publishDecisionDeclaredRowsDownSql);
}
