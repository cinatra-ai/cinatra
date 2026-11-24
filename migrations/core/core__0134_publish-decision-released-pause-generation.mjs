// core__0134 — the pause a publish decision was released at, on
// `agent_run_publish_decisions` (cinatra#4758).
// Operator-upgrade twin of the fresh-install bootstrap DDL
// (`publishDecisionSchemaQueries` in src/lib/artifacts/publication-operation-schema.ts),
// shipped in the SAME change (the core__0133 precedent).
//
// WHAT. ONE additive nullable column, `released_pause_generation` (bigint, the
// type of `agent_runs.pause_generation`): the run's pause generation at which
// the Allow released the decision, written in the same UPDATE that releases it,
// under the pause claim held at that generation. Every entry into
// `pending_approval` and every fence raises the run's pause generation, so a
// run still `pending_approval` at this generation waits at the very pause the
// decision released: its resume did not reach the fence, and Allow again may
// resume it. Any other generation means the run went on. The card and the
// retry read this durable record instead of the latest-task key (Redis, seven
// days). null = a decision not released, or released by code older than this
// column; those keep the earlier reading (the latest-task key decides, and
// without it nothing resumes).
//
// NO BACKFILL AND NO STORED VALUE CHANGES. No default, no constraint: every
// existing row reads NULL. The schema-migration gate classifies this
// NON-destructive.
//
// LOCKS. The column add is catalog-only (nullable, no default: no rewrite and
// no scan), so its ACCESS EXCLUSIVE lock is held for milliseconds once granted.
//
// LOCK WAIT. As core__0130: `up` runs outside a transaction and sets
// lock_timeout = RELEASED_PAUSE_GENERATION_LOCK_TIMEOUT_MS on its session first
// and resets it last, so an ALTER that waits behind a long reader fails (55P03)
// instead of queueing the application's statements behind it. The migration
// then stops with no ledger row, and the next run replays it.
//
// IDEMPOTENT. ADD COLUMN IF NOT EXISTS: a replay, or a run after the bootstrap
// leaf, changes nothing.
//
// DOWN drops the column and what it holds; released decisions then read as
// released by older code. Safe only once no deployed code reads the column.
//
// SEQ 0134: 0133 is the highest sequence on main (2026-11-24). A rename-only
// renumber at merge is normal. Unqualified names ride the runner's search_path
// (the app schema).

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it. */
export const publishDecisionReleasedPauseGenerationDdlSql = `ALTER TABLE agent_run_publish_decisions ADD COLUMN IF NOT EXISTS released_pause_generation bigint`;

/** The one statement of `down`: it removes only what `up` added. */
export const publishDecisionReleasedPauseGenerationDownSql = `ALTER TABLE agent_run_publish_decisions DROP COLUMN IF EXISTS released_pause_generation`;

/** The longest wait for the lock `up` takes (LOCK WAIT above), in ms. */
export const RELEASED_PAUSE_GENERATION_LOCK_TIMEOUT_MS = 5_000;

/** @param {Pick<import("node-pg-migrate").MigrationBuilder, "sql" | "noTransaction">} pgm */
export function up(pgm) {
  // One autocommit statement each; the lock_timeout is the session's, so it
  // binds the ALTER between the SET and the RESET.
  pgm.noTransaction();
  pgm.sql(`SET lock_timeout = ${RELEASED_PAUSE_GENERATION_LOCK_TIMEOUT_MS}`);
  pgm.sql(publishDecisionReleasedPauseGenerationDdlSql);
  pgm.sql("RESET lock_timeout");
}

/** @param {Pick<import("node-pg-migrate").MigrationBuilder, "sql">} pgm */
export function down(pgm) {
  pgm.sql(publishDecisionReleasedPauseGenerationDownSql);
}
