// Bootstrap DDL for the auditor review companion (cinatra#1625) — two tables:
// `auditor_proposal_snapshots` (immutable, one per agent_run_id) and
// `auditor_approval_receipts` (single-use SoD receipts).
//
// WHY A DEDICATED STORE. The auditor previously persisted its surfaced
// suggestions to `audit_events` (event_type "auditor_suggestions_emitted") and
// the apply route replay-validated against the UNION of those rows. That path
// had two live defects: (1) a retry produced a SECOND row, so the union
// broadened the accepted set beyond the exact surfaced snapshot; (2) the insert
// FAILED on a fresh-bootstrap DB, whose `audit_events` table carries only the
// structured @cinatra/authz shape (organization_id, actor_principal_id, …) —
// the legacy HITL columns (review_task_id, actor_id, event_type, payload) exist
// only on operator-UPGRADED DBs. A dedicated immutable snapshot store fixes
// both: exactly one row per run, sourced authoritatively for apply, and a shape
// present on every lineage.
//
// CONSTRAINTS the DB itself enforces:
//   - auditor_proposal_snapshots_agent_run_id_uniq — UNIQUE (agent_run_id):
//     one immutable snapshot per run. The write is an idempotent upsert keyed by
//     this column; the accessor fails closed if the same run re-runs against a
//     different input_data_digest (never silently overwrites a snapshot a
//     receipt may already be bound to).
//   - auditor_approval_receipts_live_uniq — partial UNIQUE (agent_run_id)
//     WHERE consumed_at IS NULL: at most one LIVE (unconsumed) receipt per run.
//     apply consumes it with a single-shot CAS; a second apply / forged replay
//     finds no live receipt and is rejected.
//
// NO foreign keys ON PURPOSE (the publication-operation / dispatch-ledger
// precedent): the snapshot + receipt are keyed by agent_run_id (a synthetic run
// id, no runs FK is enforced elsewhere) and must outlive run-row churn; the run
// id is validated at WRITE time by the route's run-binding guard, not FK-pinned.
//
// ADDITIVE (two brand-new empty tables + their indexes) — no artifact is
// REQUIRED. The DDL MIRRORS core__0058 exactly (idempotent CREATE … IF NOT
// EXISTS), so it is a no-op on a bootstrap-seeded schema, ledger-faked on a
// fresh install, and executed by `db migrate` on an existing deployment.
// Unqualified names ride the runner's search_path (the app schema).

type QueryInput = { text: string; values?: unknown[] };

export function auditorSnapshotSchemaQueries(schemaName: string): QueryInput[] {
  const q = schemaName.replaceAll('"', '""'); // identifier
  return [
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."auditor_proposal_snapshots" (
  id                  text PRIMARY KEY,
  agent_run_id        text NOT NULL,
  preview             jsonb NOT NULL,
  patches             jsonb NOT NULL,
  patch_ids           jsonb NOT NULL,
  input_data_digest   text NOT NULL,
  snapshot_hash       text NOT NULL,
  edited              text NOT NULL DEFAULT 'clean',
  created_at          timestamptz NOT NULL DEFAULT now()
)`,
    },
    {
      text: `CREATE UNIQUE INDEX IF NOT EXISTS auditor_proposal_snapshots_agent_run_id_uniq
  ON "${q}"."auditor_proposal_snapshots" (agent_run_id)`,
    },
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."auditor_approval_receipts" (
  id                    text PRIMARY KEY,
  agent_run_id          text NOT NULL,
  snapshot_hash         text NOT NULL,
  reviewer_id           text NOT NULL,
  accepted_patch_ids    jsonb,
  dismissed_patch_ids   jsonb,
  consumed_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
)`,
    },
    {
      text: `CREATE UNIQUE INDEX IF NOT EXISTS auditor_approval_receipts_live_uniq
  ON "${q}"."auditor_approval_receipts" (agent_run_id) WHERE consumed_at IS NULL`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS auditor_approval_receipts_run_id_idx
  ON "${q}"."auditor_approval_receipts" (agent_run_id)`,
    },
  ];
}
