// Bootstrap DDL for the durable publication-operation ledger (cinatra#1450,
// epic #1448) — one table: `artifact_publication_operations`.
//
// A draftable artifact publishes through a durable OPERATION record, never
// directly; queue jobs are DELIVERY, not authority. Each row pins the exact
// representation revision to publish, the destination, the due time, the
// attempt + idempotency key, the cancellation-generation fence, and the
// operation state (pending → running → succeeded | failed | cancelled). The
// artifact's scheduled/published status is a projection written only via this
// ledger's transitions (the #1449 trusted commands).
//
// CONSTRAINT MODEL the DB itself enforces:
//   - artifact_publication_operations_idempotency_uniq — partial UNIQUE
//     (org_id, idempotency_key) WHERE state <> 'cancelled': the no-double-publish
//     backstop. The idempotency key is derived from the external identity (org,
//     artifact, pinned revision, destination), so at most ONE live-or-succeeded
//     operation per intent may exist — a duplicate schedule (double-click) or a
//     re-publish of an already-succeeded identical revision is refused. A
//     cancelled operation FREES the slot (an edit-after-unschedule can
//     re-schedule); a genuinely new publish carries a new revision → a new key.
//   - state / attempt / cancellation_generation CHECKs — the state set and the
//     non-negative counters (the project_dispatch_attempts precedent).
//
// NO foreign keys ON PURPOSE (the artifact_uninstall_operations / dispatch-
// ledger precedent): the operation ledger is durable history that must outlive
// artifact deletion and representation-table evolution; the pinned revision and
// artifact ids are provenance the ledger validates at WRITE time (schedule
// refuses a revision that does not exist), not FK-enforced at rest.
//
// A pure string builder with ZERO imports — a synchronous leaf safe for
// drizzle-store.ts's synchronous composition (same contract as
// artifact-claim-schema.ts / skill-lifecycle-schema.ts). On an EXISTING
// deployment the table arrives via migration core__0055; on a fresh bootstrap
// it ships directly here — the two paths converge (idempotent DDL).

export function publicationOperationLedgerSchemaQueries(
  schemaName: string,
): { text: string }[] {
  const q = schemaName.replaceAll('"', '""'); // identifier
  return [
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."artifact_publication_operations" (
  id                                  text PRIMARY KEY,
  org_id                              text NOT NULL,
  artifact_id                         text NOT NULL,
  object_type_id                      text NOT NULL,
  pinned_representation_revision_id   text NOT NULL,
  destination_connector               text NOT NULL,
  destination_account                 text,
  destination_ref                     text,
  due_at                              timestamptz NOT NULL,
  state                               text NOT NULL DEFAULT 'pending',
  attempt                             integer NOT NULL DEFAULT 0,
  idempotency_key                     text NOT NULL,
  cancellation_generation             integer NOT NULL DEFAULT 0,
  receipt                             jsonb,
  error                               text,
  created_by                          text,
  created_at                          timestamptz NOT NULL DEFAULT now(),
  updated_at                          timestamptz NOT NULL DEFAULT now(),
  started_at                          timestamptz,
  settled_at                          timestamptz,
  CONSTRAINT artifact_publication_operations_state_check
    CHECK (state IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT artifact_publication_operations_attempt_check
    CHECK (attempt >= 0),
  CONSTRAINT artifact_publication_operations_generation_check
    CHECK (cancellation_generation >= 0)
)`,
    },
    {
      text: `CREATE UNIQUE INDEX IF NOT EXISTS artifact_publication_operations_idempotency_uniq ON "${q}"."artifact_publication_operations" (org_id, idempotency_key) WHERE state <> 'cancelled'`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS artifact_publication_operations_artifact_idx ON "${q}"."artifact_publication_operations" (org_id, artifact_id, cancellation_generation)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS artifact_publication_operations_type_idx ON "${q}"."artifact_publication_operations" (org_id, object_type_id, created_at DESC)`,
    },
    {
      // Due-scan seam: the delivery scanner finds due pending operations without
      // touching settled rows.
      text: `CREATE INDEX IF NOT EXISTS artifact_publication_operations_due_idx ON "${q}"."artifact_publication_operations" (due_at) WHERE state = 'pending'`,
    },
    {
      // Reconcile seam: the stale-lease sweep finds running operations by start time.
      text: `CREATE INDEX IF NOT EXISTS artifact_publication_operations_running_idx ON "${q}"."artifact_publication_operations" (started_at) WHERE state = 'running'`,
    },
  ];
}
