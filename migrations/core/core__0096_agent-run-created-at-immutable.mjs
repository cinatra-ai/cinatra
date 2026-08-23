// core__0096 — `agent_runs.created_at` is IMMUTABLE after insert (cinatra#2911).
//
// The operator-upgrade twin of the fresh-install bootstrap leaf
// `agentRunCreatedAtSchemaQueries` (src/lib/agent-run-created-at-schema.ts,
// spread into `buildCreateStoreSchemaQueries` in the SAME PR).
//
// THE DEFECT. The bootstrap DDL carried, with no WHERE clause,
//
//     UPDATE … agent_runs SET created_at = COALESCE(started_at, completed_at, created_at)
//
// immediately after the idempotent `ADD COLUMN IF NOT EXISTS created_at`. The
// surrounding DDL is idempotent; that UPDATE was idempotent only against FIXED
// inputs, and `started_at` / `completed_at` are populated LATER in a run's life.
// `ensurePostgresSchema` replays the WHOLE list once per fresh server process
// (the `globalThis` flag and the pid-keyed done-marker skip it only within one
// process), so every restart recomputed `created_at` from data that did not
// exist when the row was inserted: a run that had reached `running` reported
// `started_at` as its creation time, and a run that FAILED before it started
// reported `completed_at` — its own end time — while the child rows it owns
// appeared to predate it. `created_at` is the only record of when a run was
// REQUESTED, the run listings order by it, and the loss was silent and
// irreversible.
//
// WHY THIS MIGRATION EXISTS AT ALL. The versioned chain carried NOTHING for
// this column: an operator database only ever received `created_at` from the
// bootstrap DDL, which runs AHEAD of the chain. So the chain and the
// fresh-install path disagreed about who owns the column. This module closes
// that gap by shipping the SAME three idempotent statements the leaf now emits,
// so both paths land on one shape and the immutable form is recorded in the
// versioned history rather than only in bootstrap text.
//
// THE SHAPE. The column is added NULLABLE and WITHOUT a default — that is what
// makes "never had a creation timestamp" distinguishable from "already carries
// one". A row that predates the column lands on NULL; a row that already has a
// value keeps it, because the backfill narrows on `created_at IS NULL`. The
// default and the NOT NULL are applied AFTERWARDS, so the final shape is exactly
// what it was (timestamptz NOT NULL DEFAULT now()) and the insert path keeps
// relying on the database default. Adding the column WITH a default would defeat
// the guard: PostgreSQL fills every existing row with it, so nothing would be
// NULL and no row would be distinguishable from one that never had a value.
//
// ON AN ALREADY-BOOTSTRAPPED DATABASE — which is every deployed instance, since
// the column has existed since the agent_runs consolidation — all three
// statements are no-ops: the column exists, no row is NULL, the default and the
// constraint are in place (SET NOT NULL skips its validation scan when
// `attnotnull` is already set). Nothing is rewritten. That is the point: after
// this migration NO path recomputes a present `created_at` from another column.
//
// DESTRUCTIVE by the convention's enumeration (migrations/README.md): it carries
// a data rewrite (the guarded backfill) and a SET NOT NULL on an existing table.
// Both are strictly NARROWER than what shipped before — the backfill it replaces
// had no predicate at all, and the NOT NULL restores a constraint the column
// already carries on every deployed instance.
//
// NO BACKFILL OF THE ALREADY-CORRUPTED VALUES, and that is a decision rather
// than an omission: a `created_at` that was collapsed onto `started_at` or
// `completed_at` is indistinguishable from one that was always that value, and
// the pre-replay value is not stored anywhere. This change stops further loss;
// it cannot reconstruct what earlier replays destroyed.
//
// Unqualified names ride the runner's search_path (the app schema), matching
// every sibling module in this chain.
//
// SEQ 0096 — strictly greater than the max shipped seq on origin/main
// (core__0095 run-recommendation-skip-record). migrations/** is HIGH-RISK:
// owner approval required; the lane never merges.
//
// DOWN. Deliberately a no-op. The forward shape is the column's ALREADY-DEPLOYED
// shape (timestamptz NOT NULL DEFAULT now()), so there is nothing to restore:
// dropping the column would destroy every run's creation time, and re-widening
// it to nullable or re-installing the unguarded rewrite would reinstate the very
// defect this migration removes. An operator-initiated `--down` therefore leaves
// the column exactly as it is.

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it, and a no-op on any database the bootstrap has already touched. */
export const agentRunCreatedAtImmutableDdlSql = `
  ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS created_at timestamptz;
  UPDATE agent_runs SET created_at = COALESCE(started_at, completed_at, now()) WHERE created_at IS NULL;
  ALTER TABLE agent_runs ALTER COLUMN created_at SET DEFAULT now(), ALTER COLUMN created_at SET NOT NULL;
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(agentRunCreatedAtImmutableDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down() {
  // Intentionally empty — see DOWN above. The forward shape IS the deployed
  // shape; there is no earlier shape to restore that would not either destroy
  // every run's creation time or reinstate the rewrite this migration removes.
}
