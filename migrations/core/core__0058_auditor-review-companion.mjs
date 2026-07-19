// core__0058 — auditor review companion store (cinatra#1625).
//
// Two brand-new tables backing the host half of the auditor HITL flow:
//
//   `auditor_proposal_snapshots` — immutable, ONE per agent_run_id. The audit
//     run (/api/auditor/run-skills phase:run) generates the personal-skill
//     preview (name/description/content) + the per-item SuggestionPatch[] from
//     the audit material (the agent's own skills + matched skills +
//     HITL-selected skills + the artifact + the user's applied changes) and
//     writes exactly one snapshot row. /api/auditor/apply replay-validates
//     acceptedPatchIds ⊆ this row's patch_ids — the authoritative surfaced set,
//     NOT the UNION of retry rows the retired audit_events path unioned.
//
//   `auditor_approval_receipts` — single-use Separation-of-Duties receipts.
//     approveReviewTask (admin-gated, SoD self-approval guard) mints one bound
//     to (agent_run_id, snapshot_hash, reviewer_id) when a pending auditor
//     snapshot exists; /api/auditor/apply CONSUMES it with a single-shot CAS.
//     A second apply / forged resume replay finds no live receipt → 403.
//
// WHY (bug fixes, not just cleanliness). The prior audit_events
// "auditor_suggestions_emitted" persistence path (1) let a retry BROADEN the
// accepted set via the union, and (2) FAILED TO INSERT on a fresh-bootstrap DB
// whose audit_events carries only the structured @cinatra/authz shape — the
// legacy HITL columns (review_task_id, actor_id, event_type, payload) exist
// only on operator-UPGRADED DBs. The dedicated store is present on every
// lineage and pins exactly one authoritative snapshot per run.
//
// NO foreign keys ON PURPOSE (publication-operation / dispatch-ledger
// precedent): both tables key by agent_run_id (a synthetic run id) and must
// outlive run-row churn; the id is validated at WRITE time by the route
// run-binding guard, not FK-pinned.
//
// ADDITIVE (two brand-new empty tables + indexes; migrations/README.md
// "Additive") — no artifact is REQUIRED. Shipped anyway (the core__0055/0047
// precedent) so fresh-bootstrap and operator-upgrade paths stay aligned. The
// DDL MIRRORS the idempotent bootstrap leaf
// (buildCreateStoreSchemaQueries → auditorSnapshotSchemaQueries, the pure-strings
// leaf src/lib/auditor-snapshot-schema.ts, spread in the SAME PR) — a no-op on a
// bootstrap-seeded schema, ledger-faked on a fresh install, executed by
// `db migrate` on an existing deployment. Unqualified names ride the runner's
// search_path (the app schema); metadata-only DDL on empty tables, no
// noTransaction().
//
// SEQ assigned at MERGE-time reconcile: shipped max on origin/main is now
// core__0057 (environment-layer-store, #1843), so this migration takes the next
// free seq core__0058 (rename-only renumber from the provisional 0057 after
// #1843's env-layer store claimed 0057). Migration seq is assigned at MERGE — a
// concurrent lane may land the next seq first, in which case a rename-only
// renumber is normal. migrations/** is HIGH-RISK (owner approval); the lane
// never merges.

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it. */
export const auditorReviewCompanionDdlSql = `
  CREATE TABLE IF NOT EXISTS auditor_proposal_snapshots (
    id                  text PRIMARY KEY,
    agent_run_id        text NOT NULL,
    preview             jsonb NOT NULL,
    patches             jsonb NOT NULL,
    patch_ids           jsonb NOT NULL,
    input_data_digest   text NOT NULL,
    snapshot_hash       text NOT NULL,
    edited              text NOT NULL DEFAULT 'clean',
    created_at          timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS auditor_proposal_snapshots_agent_run_id_uniq
    ON auditor_proposal_snapshots (agent_run_id);

  CREATE TABLE IF NOT EXISTS auditor_approval_receipts (
    id                    text PRIMARY KEY,
    agent_run_id          text NOT NULL,
    snapshot_hash         text NOT NULL,
    reviewer_id           text NOT NULL,
    accepted_patch_ids    jsonb,
    dismissed_patch_ids   jsonb,
    consumed_at           timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS auditor_approval_receipts_live_uniq
    ON auditor_approval_receipts (agent_run_id) WHERE consumed_at IS NULL;
  CREATE INDEX IF NOT EXISTS auditor_approval_receipts_run_id_idx
    ON auditor_approval_receipts (agent_run_id);
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(auditorReviewCompanionDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible: both tables are fresh additions, so dropping them restores the
  // exact pre-0058 shape on any lineage (indexes ride the table drop). HONEST
  // COST: any in-flight auditor snapshot/receipt rows are lost — an
  // operator-initiated `--down` deliberately accepts that (the tables carry no
  // data on a fresh install and an interrupted auditor run is re-runnable).
  pgm.sql(`DROP TABLE IF EXISTS auditor_approval_receipts;`);
  pgm.sql(`DROP TABLE IF EXISTS auditor_proposal_snapshots;`);
}
