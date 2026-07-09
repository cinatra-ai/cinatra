// core__0019 — run-token spine: dispatch-minted per-run credential hash
// (cinatra-ai/cinatra#1193, W1 of the run-identity-spine epic #1192).
//
// WHY. Run identity reaches the app through several parallel, re-derived
// channels (a forgeable `cinatra_run_id` flow input, an A2A context-id header,
// a dispatcher-signed binding, an in-process registry). The epic collapses
// them onto ONE dispatch-minted per-run credential verified everywhere. This
// migration lands the credential's PERSISTENCE half: a new `run_token_hash`
// column on `agent_runs` holding ONLY the sha256-hex of the random per-run
// token (the raw token never touches the database — it lives only in the
// WayFlow initial message and, in a later wave, first-party callbacks). A
// single server verifier hashes a presented token and looks the run up by this
// column; uniqueness makes that lookup unambiguous (no newest-wins tie-break).
//
// CLASSIFICATION. Adding a UNIQUE index to an existing table is "destructive"
// under migrations/README.md (it can fail on existing duplicates), so this
// artifact is REQUIRED even though the change is additive in shape. It cannot
// fail in practice: `run_token_hash` is a brand-new column, so every
// pre-existing row is NULL and the PARTIAL predicate (`WHERE run_token_hash
// IS NOT NULL`) excludes all of them — the index is created over zero rows.
// This mirrors the notifications.dedupe_key partial-unique precedent
// (core__0001).
//
// ADDITIVE + idempotent: `ADD COLUMN IF NOT EXISTS` + `CREATE UNIQUE INDEX IF
// NOT EXISTS` on the existing table. It rides the idempotent bootstrap DDL
// (buildCreateStoreSchemaQueries in src/lib/drizzle-store.ts adds the SAME
// column + index this PR), so it is a no-op on a bootstrap-seeded schema and
// ledger-faked on a fresh install; `db migrate` executes it on an existing
// deployment. No `noTransaction()` — the partial index over an all-NULL column
// is instant and runs safely inside the migration's own transaction (unlike
// `CREATE INDEX CONCURRENTLY`, which would require it). Unqualified names ride
// the runner's search_path (the app schema). Reversible: down() drops the
// index then the column.
//
// RESUME/CLONE INVARIANT (enforced in code, not here): every agent_runs
// insert path (createAgentRun / createAgentRunPendingInput) builds its VALUES
// from an explicit column whitelist, so a resumed/cloned/child run never
// inherits a parent's hash — the column is written only by the dispatcher's
// setAgentRunTokenHash before the blocking sendTask.

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`ALTER TABLE agent_runs
    ADD COLUMN IF NOT EXISTS run_token_hash text;`);
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_run_token_hash_uniq
    ON agent_runs (run_token_hash)
    WHERE run_token_hash IS NOT NULL;`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible: drop the index then the additive column (restores the
  // pre-0019 shape on any lineage). The column is a fresh #1193 addition, so
  // no legitimate data is lost — the raw token was never stored, and a dropped
  // hash simply reverts run selection to the legacy channels.
  pgm.sql(`DROP INDEX IF EXISTS agent_runs_run_token_hash_uniq;`);
  pgm.sql(`ALTER TABLE agent_runs DROP COLUMN IF EXISTS run_token_hash;`);
}
