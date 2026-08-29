// core__0100 — index `artifact_produced_outbox` by its PRODUCING RUN (cinatra#3007).
//
// The operator-upgrade twin of the bootstrap leaf's new index in
// `src/lib/artifacts/artifact-review-gate-schema.ts`, added in the SAME PR.
//
// WHY. cinatra#3007 puts a run's review moment BEFORE its terminal status, and
// the first thing the executor now asks at every completion is whether this run
// produced anything a review could be open on:
//
//     SELECT event_id FROM artifact_produced_outbox
//      WHERE org_id = $1 AND producer_run_id = $2 LIMIT 1
//
// That question is asked once per terminating run, and for the overwhelming
// majority of runs the answer is NO — which is exactly the case a `LIMIT 1` does
// not help, because proving absence means reading every candidate row. The table
// carried indexes on `(status, created_at)` and `(org_id)` only, so on an
// instance with a large tenant the absent-match probe degraded into a scan of
// that tenant's whole produced history, on the completion hot path. The same
// access pattern is repeated by the hold predicate and by the release drain.
//
// SHAPE. One composite index on `(org_id, producer_run_id)`: the probe's exact
// leading columns, and a prefix match for the predicate's per-run reads. Rows
// with a NULL `producer_run_id` (a direct upload, which has no producing run)
// still occupy an entry; they are a small minority and excluding them would cost
// the index its usefulness as a plain prefix.
//
// ADDITIVE AND NON-DESTRUCTIVE: it creates one index, touches no column, no
// constraint and no row. `IF NOT EXISTS` makes it a no-op wherever the bootstrap
// DDL already created it, and the bootstrap is equally safe to run after this.
//
// NOT `CONCURRENTLY`, deliberately: the runner executes each migration inside a
// transaction, which `CREATE INDEX CONCURRENTLY` cannot join, and every other
// index on this table was created the same plain way by the bootstrap DDL.
//
// SEQ 0100 — strictly greater than the max shipped seq on origin/main
// (core__0099 artifact-produced-outbox-object-snapshot-mint-emitter). A
// concurrent lane may land the next seq first, in which case a rename-only
// renumber is normal (FLAGGED for the coordinator's train).
// migrations/** is HIGH-RISK: owner approval required; the lane never merges.

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it, and safe
 *  for the bootstrap to run after it. */
export const producedOutboxProducerRunIdxSql = `
  CREATE INDEX IF NOT EXISTS artifact_produced_outbox_producer_run_idx
    ON artifact_produced_outbox (org_id, producer_run_id);
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(producedOutboxProducerRunIdxSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible with no data loss: an index carries no rows of its own. Dropping
  // it restores the pre-migration plan for the completion probe (a tenant-wide
  // scan), which is slower but correct.
  pgm.sql(`DROP INDEX IF EXISTS artifact_produced_outbox_producer_run_idx;`);
}
