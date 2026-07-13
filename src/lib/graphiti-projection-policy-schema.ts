// Bootstrap DDL for the Graphiti projection-policy EPOCH + the durable
// rebuild journal (cinatra#1427 ACs 4-5, epic #1424 projection decision):
//
//   - graphiti_projection_policy     ONE row per org-group (`cinatra-org-<id>`
//                                    / `cinatra-default`): the group's current
//                                    projection-policy epoch. A group with NO
//                                    row is implicitly at epoch 1 — readers
//                                    COALESCE to 1; the first bump inserts the
//                                    row at epoch 2. Epochs are MONOTONIC
//                                    (never decremented): rollback is a NEW
//                                    fenced rebuild at a NEW epoch that
//                                    replays the (reverted) policy from
//                                    Postgres — per-episode purge / epoch
//                                    decrement is explicitly NOT the
//                                    mechanism (issue #1427: append-before-
//                                    success, no episode UUID control, capped
//                                    enumeration).
//   - graphiti_rebuild_journal       the durable rebuild journal (group,
//                                    epoch, phase, checkpoint): an epoch bump
//                                    opens (or folds into) the group's single
//                                    open journal row; the driver in
//                                    @cinatra-ai/objects/graphiti-rebuild
//                                    advances phase clearing → replaying →
//                                    verifying → done with a persisted replay
//                                    checkpoint, so a killed projector resumes
//                                    instead of restarting (AC-4). Every
//                                    driver write is CAS-guarded on
//                                    (phase, to_epoch) — a fold that re-bumps
//                                    the epoch mid-rebuild strands the stale
//                                    driver's writes harmlessly.
//
// The outbox epoch column (`graphiti_projection_outbox.projection_epoch`) is
// the LAST entry below (the outbox table itself pre-exists by the time
// drizzle-store.ts spreads these queries): rebuild-replay items are STAMPED
// with their target epoch and discarded by the worker when the group's epoch
// has moved on (stale-epoch fencing); ordinary write-path items stay NULL and
// always process under the group's live policy.
//
// A pure string builder with ZERO imports — a synchronous leaf, safe for
// drizzle-store.ts's synchronous require() composition (same contract as
// artifact-claim-schema.ts / skill-lifecycle-schema.ts). Purely ADDITIVE
// evolution (new tables + a nullable column), so it ships via the idempotent
// bootstrap on BOTH fresh and existing deployments — no core migration
// (migrations/README.md: versioned migrations are for transformational
// change).
//
// The phase vocabulary below is a schema contract mirrored by
// REBUILD_JOURNAL_PHASES in @cinatra-ai/objects/graphiti-rebuild; the rebuild
// unit test asserts they stay in sync.

export function graphitiProjectionPolicySchemaQueries(schemaName: string): { text: string }[] {
  const q = schemaName.replaceAll('"', '""'); // identifier
  return [
    // ---- graphiti_projection_policy: per-group epoch bookkeeping ----
    { text: `CREATE TABLE IF NOT EXISTS "${q}"."graphiti_projection_policy" (
      group_id text PRIMARY KEY,
      epoch integer NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT graphiti_projection_policy_epoch_check CHECK (epoch >= 1)
    )` },

    // ---- graphiti_rebuild_journal: durable rebuild state machine ----
    // `checkpoint` is the replay cursor ({ lastObjectId, enqueued }) — moved
    // atomically WITH each replay-batch outbox INSERT (one data-modifying CTE
    // statement), so a kill between batches never double-advances and a
    // duplicate enqueue after a kill inside a batch is impossible.
    // `reason` records provenance ('claim-change' with the consumed
    // re-projection queue row ids / object types, or 'rollback').
    // `from_epoch` is preserved across folds (a second claim-change bump
    // folding into an open journal keeps the ORIGINAL pre-rebuild epoch).
    { text: `CREATE TABLE IF NOT EXISTS "${q}"."graphiti_rebuild_journal" (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      group_id text NOT NULL,
      org_id text,
      from_epoch integer NOT NULL,
      to_epoch integer NOT NULL,
      phase text NOT NULL DEFAULT 'clearing',
      checkpoint jsonb,
      stats jsonb,
      reason jsonb NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT graphiti_rebuild_journal_phase_check CHECK (phase IN ('clearing','replaying','verifying','done')),
      CONSTRAINT graphiti_rebuild_journal_epoch_check CHECK (to_epoch > from_epoch)
    )` },
    // ONE open rebuild per group — a second epoch bump FOLDS into the open
    // journal (ON CONFLICT on this partial index) instead of racing it.
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS graphiti_rebuild_journal_one_open
      ON "${q}"."graphiti_rebuild_journal" (group_id) WHERE phase <> 'done'` },
    { text: `CREATE INDEX IF NOT EXISTS graphiti_rebuild_journal_open_idx
      ON "${q}"."graphiti_rebuild_journal" (created_at) WHERE phase <> 'done'` },

    // ---- outbox epoch stamp: stale-epoch fencing for rebuild replays ----
    // NULL = ordinary write-path item (always processed under the group's
    // live policy); non-NULL = rebuild-replay item, discarded by the worker
    // when the group's epoch has moved past it.
    { text: `ALTER TABLE "${q}"."graphiti_projection_outbox" ADD COLUMN IF NOT EXISTS projection_epoch integer` },
  ];
}
