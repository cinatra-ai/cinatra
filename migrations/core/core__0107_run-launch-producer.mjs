// core__0107 — WHAT STARTED THE RUN (cinatra#3450, epic #3248).
//
// The operator-upgrade twin of the fresh-install bootstrap half widened in the
// SAME PR:
//
//   * the `agent_runs` column entry        (src/lib/drizzle-store.ts)
//
// The parity suite compares that string against the one below, together with
// the Drizzle declaration in packages/agents/src/schema.ts.
//
// WHAT IT STORES. The producer key the launch fence received — the inventory
// key `RUN_PRODUCERS` records, which every product road already hands to
// `launchAgentRun` (`packages/agents/src/lifecycle-coordinator.ts`, the one
// fenced creation entry) and which was until now persisted nowhere. A run
// started from inside another run therefore reads back with a task id, an
// execution attempt id and a parent, and nothing at all about what launched it;
// with this column, the run's record names its origin.
//
// WHY NOT A TRIGGER RECORD. The issue that asks for this first named one, and
// the mechanism is corrected on the issue itself: the ABSENCE of an
// `agent_run_triggers` row is the shipped signal for "no schedule chosen yet" —
// the setup-to-trigger hand-off, the finished-run notice and the trigger gate
// all read it that way — so a row written at launch would skip the schedule
// step for everyone. The trigger record keeps meaning "a schedule was chosen",
// and what started a run is recorded on the run.
//
// WHY A COLUMN OF ITS OWN. Nothing else on the row answers the question. The
// actor can be re-pointed, the parent says which run this one hangs off and not
// which road launched it, and the dispatch shape is a property of the moment,
// not of the origin. It is deliberately NOT `producer_run_id`, which is a
// different table's column naming the run that PRODUCED an artifact. This
// column is written ONCE, at creation, from the key the fence received, and
// never updated.
//
// ADDITIVE AND NULLABLE, WITH NO BACKFILL. A row that predates the column reads
// NULL, which is the honest record of a start nobody wrote down; inferring one
// from another column would be recording a launch nobody made. That is also why
// nothing here is ever set NOT NULL.
//
// IDEMPOTENT: the statement is ADD COLUMN IF NOT EXISTS, so this is a no-op on a
// database the bootstrap already created wide and a widening on every deployed
// one, and it writes to no existing row.
//
// NOT DESTRUCTIVE by the convention's classifier: it adds one nullable column,
// changes no key, replaces no index, and deletes nothing.
//
// SEQ 0107 — strictly greater than the max shipped seq on the default branch
// (core__0105, the image-generation ledger provenance). 0106 is skipped rather
// than taken: it is already claimed by an open change, and two modules sharing a
// number fail the runner's duplicate-seq preflight at boot. The convention reads
// NOT-ALREADY-TAKEN rather than HIGHEST (cinatra#3029), so a gap is legal; a
// lane that lands 0107 first is answered by the same rename onto the next free
// number, both halves together. migrations/** is HIGH-RISK: maintainer approval
// required; the lane never merges.
//
// DOWN. Drops the column. The honest cost is stated rather than hidden: the
// recorded origins go with it, and because there is no backfill there is nothing
// to re-derive them from — every run returns to being attested without what
// started it, which is exactly where they were before this migration.

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it, and a
 *  no-op on any database the bootstrap has already created wide. */
export const runLaunchProducerDdlSql = `
  ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS launch_producer text;
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(runLaunchProducerDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`
    ALTER TABLE agent_runs DROP COLUMN IF EXISTS launch_producer;
  `);
}
