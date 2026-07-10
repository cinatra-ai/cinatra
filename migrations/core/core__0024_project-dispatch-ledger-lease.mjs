// core__0024 — dynamic-dispatch primitive storage (cinatra#1032 deliverable 2).
//
// Adds the two tables the project dynamic-dispatch primitive persists to:
//
// `project_dispatch_attempts` — the dispatch-attempt LEDGER. One row per
// deliberate dispatch attempt, keyed by (org_id, item_natural_key,
// action_version); the row is written AHEAD of `createAgentRun` and carries the
// deterministically derived idempotency key that is passed VERBATIM to
// `createAgentRun`, so a tick that crashes between dispatch and record cannot
// double-dispatch: the next tick re-begins the SAME ledger key, re-derives the
// SAME idempotency key, and `agent_runs_idempotency_key_uniq` resolves it to
// the SAME child run. `run_id` is provenance only — deliberately NO foreign key
// (the ledger is append-only history that outlives the operational run row; an
// FK SET NULL would erase the historical run identity and re-open a redispatch
// ambiguity). `version` is the optimistic-CAS counter (core__0007 shape).
//
// `project_leases` — the project-level lease (single active tick per PM project
// scope). Keyed (org_id, project_ref); heartbeat/expiry columns plus a fencing
// `version` bumped on every (re)acquisition so a stale holder's writes are
// rejected by version mismatch. Stale-lease recovery = an acquire whose
// conditional upsert only wins when `expires_at <= now()` (or the caller is the
// live holder re-acquiring).
//
// ADDITIVE change (two brand-new tables, see migrations/README.md "Additive"):
// they ride the idempotent bootstrap DDL (`projectDispatchSchemaQueries`,
// spread into buildCreateStoreSchemaQueries in the SAME PR), so an artifact is
// NOT required. This module ships anyway — the core__0007 precedent — to keep
// the fresh-bootstrap and operator-upgrade paths aligned and give the tables a
// ledgered row; it is pure CREATE … IF NOT EXISTS, so it is a no-op on a
// bootstrap-seeded schema and ledger-faked on a fresh install. Unqualified
// names ride the runner's search_path (the app schema).

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`CREATE TABLE IF NOT EXISTS project_dispatch_attempts (
    id text PRIMARY KEY,
    org_id text NOT NULL,
    project_ref text NOT NULL,
    item_natural_key text NOT NULL,
    action_version integer NOT NULL,
    worker_role text NOT NULL,
    worker_package text NOT NULL,
    worker_version_constraint text NOT NULL,
    idempotency_key text NOT NULL,
    run_id text,
    status text NOT NULL DEFAULT 'pending',
    error text,
    version integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT project_dispatch_attempts_status_check
      CHECK (status IN ('pending', 'dispatched', 'failed')),
    CONSTRAINT project_dispatch_attempts_action_version_check
      CHECK (action_version >= 0)
  );`);
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS project_dispatch_attempts_item_action_uniq
    ON project_dispatch_attempts (org_id, item_natural_key, action_version);`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS project_dispatch_attempts_project_idx
    ON project_dispatch_attempts (org_id, project_ref);`);

  pgm.sql(`CREATE TABLE IF NOT EXISTS project_leases (
    org_id text NOT NULL,
    project_ref text NOT NULL,
    holder_id text NOT NULL,
    acquired_at timestamptz NOT NULL DEFAULT now(),
    heartbeat_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    version integer NOT NULL DEFAULT 1,
    PRIMARY KEY (org_id, project_ref)
  );`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible: both tables are fresh #1032 additions, so down() restores the
  // exact pre-0024 shape on any lineage (indexes ride the table drops, listed
  // explicitly for symmetry with up()).
  pgm.sql(`DROP INDEX IF EXISTS project_dispatch_attempts_item_action_uniq;`);
  pgm.sql(`DROP INDEX IF EXISTS project_dispatch_attempts_project_idx;`);
  pgm.sql(`DROP TABLE IF EXISTS project_dispatch_attempts;`);
  pgm.sql(`DROP TABLE IF EXISTS project_leases;`);
}
