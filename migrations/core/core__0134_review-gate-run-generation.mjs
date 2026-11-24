// core__0134 — the attempt a review gate belongs to, on `artifact_review_gates`
// (cinatra#4762). Operator-upgrade twin of the fresh-install bootstrap DDL (the
// gate-store extension lines in src/lib/artifacts/artifact-review-gate-schema.ts),
// shipped in the SAME change (the core__0130 precedent).
//
// WHAT. ONE additive nullable column, `run_generation` (integer): the run's
// `reset_generation` when the gate was raised, read from the run row in the
// insert while the run executes (running or pending_approval), else -1. A
// retry's reset raises the run's generation once in its compare-and-set and
// nothing else writes it, so a publish gate counts only the reviews raised in
// the attempt that reached it, whatever later writes do to the run's start
// stamp. null = a gate raised before this column existed (or from an event
// that names no attempt): read as generation 0 once settled, and while still
// open it holds every attempt's publish fence (it may be that attempt's).
//
// And ONE additive nullable column, `producer_run_generation` (integer), on
// `artifact_produced_outbox`: the producing run's `reset_generation` when the
// event was written, read from the run row in the insert while the run executes,
// else -1. The automatic review the delayed drain raises for the event carries
// this value, not the run's state at drain time, so output of an attempt a retry
// ended never counts as a review of the next attempt. null = an event written
// before this column existed, of an unknown attempt: while pending it holds
// every attempt's publish fence of its run, and its review is stamped null.
//
// No backfill, no default, no constraint change: every existing row reads NULL.
// A run reset before the upgrade has its reviews read as generation 0, so they
// do not count for its later attempt: such a run ends stopped at its publish
// gate rather than publishing without a review of its own attempt.
//
// LOCK WAIT. As core__0130: `up` runs outside a transaction and sets
// lock_timeout = REVIEW_GATE_RUN_GENERATION_LOCK_TIMEOUT_MS on its session first
// and resets it last, so an ALTER that waits behind a long reader fails (55P03)
// instead of queueing the application's statements behind it. The migration
// then stops with no ledger row, and the next run replays it. The add itself is
// catalog-only (nullable, no default).
//
// IDEMPOTENT. ADD COLUMN IF NOT EXISTS: a replay, or a run after the bootstrap
// leaf, changes nothing.
//
// DOWN drops both columns and the generations they hold. Safe only once no
// deployed code reads the column.
//
// SEQ 0134: 0133 is the highest sequence on main (2026-11-23). A rename-only
// renumber at merge is normal. Unqualified names ride the runner's search_path
// (the app schema).

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it. */
export const reviewGateRunGenerationDdlSql = `ALTER TABLE artifact_review_gates ADD COLUMN IF NOT EXISTS run_generation integer`;

/** The produced-event twin, mirroring the bootstrap leaf — safe to run after it. */
export const producedOutboxRunGenerationDdlSql = `ALTER TABLE artifact_produced_outbox ADD COLUMN IF NOT EXISTS producer_run_generation integer`;

/** The statements of `down`: they remove only what `up` added. */
export const reviewGateRunGenerationDownSql = `ALTER TABLE artifact_review_gates DROP COLUMN IF EXISTS run_generation`;
export const producedOutboxRunGenerationDownSql = `ALTER TABLE artifact_produced_outbox DROP COLUMN IF EXISTS producer_run_generation`;

/** The longest wait for the lock `up` takes (LOCK WAIT above), in ms. */
export const REVIEW_GATE_RUN_GENERATION_LOCK_TIMEOUT_MS = 5_000;

/** @param {Pick<import("node-pg-migrate").MigrationBuilder, "sql" | "noTransaction">} pgm */
export function up(pgm) {
  // One autocommit statement each; the lock_timeout is the session's, so it
  // binds the ALTER between the SET and the RESET.
  pgm.noTransaction();
  pgm.sql(`SET lock_timeout = ${REVIEW_GATE_RUN_GENERATION_LOCK_TIMEOUT_MS}`);
  pgm.sql(reviewGateRunGenerationDdlSql);
  pgm.sql(producedOutboxRunGenerationDdlSql);
  pgm.sql("RESET lock_timeout");
}

/** @param {Pick<import("node-pg-migrate").MigrationBuilder, "sql">} pgm */
export function down(pgm) {
  pgm.sql(producedOutboxRunGenerationDownSql);
  pgm.sql(reviewGateRunGenerationDownSql);
}
