// core__0081 — lifecycle-interceptions S2 repair loop (cinatra#2040, epic #2037)
// — the operator-upgrade twin of the fresh-install bootstrap DDL
// (lifecycleRepairSchemaQueries) co-located in the already route-reachable
// src/lib/artifacts/artifact-review-gate-schema.ts and spread into
// buildCreateStoreSchemaQueries in the SAME PR.
//
// S2 ships the FIRST complete request→repair→re-review round-trip and the two
// routed schema additions. Four brand-new tables + additive CHECK-expansions on
// the #1796 gate/audit tables:
//
//   lifecycle_batch_epoch        — the DURABLE sealed-membership epoch that
//                                  REPLACES S1's in-memory seal. The frozen
//                                  membership is persisted BEFORE any gate emit +
//                                  keyed on (org, run, membership_hash); a re-sweep
//                                  after a crash recovers the FROZEN set (never
//                                  re-snapshots a grown pending set) — closing the
//                                  crash-window residual S1's PR body documents. A
//                                  PARTIAL UNIQUE index enforces at most ONE 'sealed'
//                                  (open) epoch per production.
//   lifecycle_batch_disposition  — the durable per-epoch AGGREGATE disposition
//                                  (approved / changes_requested / rejected /
//                                  partially_approved) S2 owns (S1 left it pure).
//   lifecycle_repair             — the repair LINEAGE: a changes_requested request
//                                  (base target + CAS witness + structured
//                                  findings), the cycle-guard attempt counter, the
//                                  route (producer_repair / org_repair_route /
//                                  human_escalation), and the successor gate +
//                                  repaired revision the producer returns. UNIQUE
//                                  gate_id (one repair per gate).
//   run_rejected_recommendations — the routed AC-6 rejected-recommendation efficacy
//                                  row (S3 computed it transiently in
//                                  summarizeRecommendationEfficacy and DROPPED it);
//                                  mirrors run_selected_skill_revisions (the
//                                  ACCEPTED half). UNIQUE (run_id, skill_id).
//
// CHECK-EXPANSIONS — 'changes_requested' becomes a terminal gate disposition + an
// audit disposition. Idempotent DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT
// (postgres names a column CHECK `<table>_<column>_check` deterministically), so a
// re-run on an already-expanded schema is a no-op and on an existing deployment it
// widens the constraint.
//
// NO foreign keys to agent_runs / agent_templates ON PURPOSE (the review-gate
// precedent): rows are keyed by run/gate ids validated at write time and outlive
// run-row churn. lifecycle_batch_disposition FKs lifecycle_batch_epoch(id) ON
// DELETE CASCADE (meaningless without its epoch); lifecycle_repair carries the gate
// id by value (the gate is NOT FK-pinned — the same synthetic-id/run-churn
// tolerance the gate store itself uses).
//
// ADDITIVE + IDEMPOTENT — the DDL MIRRORS the bootstrap leaf exactly (CREATE …
// IF NOT EXISTS, DROP/ADD CONSTRAINT): a no-op on a bootstrap-seeded schema,
// ledger-faked on a fresh install, executed by db migrate on an existing
// deployment. Unqualified names ride the runner's search_path (the app schema).
// metadata-only DDL over empty/additive tables; no noTransaction().
//
// SEQ 0081 — strictly greater than the max shipped seq on origin/main (core__0079,
// from the merged #2038 lifecycle S0 set). core__0080 is CLAIMED by the in-flight
// open PR #2049 (dashboard entity links). A concurrent lane may land 0080 (or the
// next seq) first, in which case a rename-only renumber is normal (FLAGGED for the
// coordinator's train). migrations/** is HIGH-RISK: owner approval required; the
// lane never merges.
//
// DOWN. Drops the four fresh tables (children before parents) and reverts the
// CHECK-expansions to the S0 vocabulary. HONEST COST: any repair / batch-epoch /
// rejected-recommendation rows are lost, and a --down over a schema that still
// carries a resolved 'changes_requested' gate would fail the reverted CHECK — an
// operator --down accepts that (empty on a fresh install; nothing consumes them
// until S2 activation).

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it. */
export const lifecycleRepairDdlSql = `
  -- CHECK-expansions: 'changes_requested' terminal gate disposition + audit disposition.
  ALTER TABLE artifact_review_gates DROP CONSTRAINT IF EXISTS artifact_review_gates_disposition_check;
  ALTER TABLE artifact_review_gates ADD CONSTRAINT artifact_review_gates_disposition_check
    CHECK (disposition IN ('approve','reject','changes_requested'));
  ALTER TABLE artifact_review_gates DROP CONSTRAINT IF EXISTS artifact_review_gates_resolved_chk;
  ALTER TABLE artifact_review_gates ADD CONSTRAINT artifact_review_gates_resolved_chk CHECK (
    status = 'pending'
    OR (disposition IN ('approve','reject','changes_requested') AND fingerprint IS NOT NULL AND resolved_at IS NOT NULL)
  );
  ALTER TABLE artifact_review_audit DROP CONSTRAINT IF EXISTS artifact_review_audit_disposition_check;
  ALTER TABLE artifact_review_audit ADD CONSTRAINT artifact_review_audit_disposition_check
    CHECK (disposition IN ('approve','reject','comment','changes_requested'));

  CREATE TABLE IF NOT EXISTS lifecycle_batch_epoch (
    id               text PRIMARY KEY,
    org_id           text NOT NULL,
    producer_run_id  text NOT NULL,
    membership_hash  text NOT NULL,
    membership       jsonb NOT NULL,
    target_count     integer NOT NULL,
    status           text NOT NULL DEFAULT 'sealed'
                       CHECK (status IN ('sealed','partitioned')),
    sealed_at        timestamptz NOT NULL DEFAULT now(),
    partitioned_at   timestamptz,
    CONSTRAINT lifecycle_batch_epoch_uniq UNIQUE (org_id, producer_run_id, membership_hash)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_batch_epoch_open_uniq
    ON lifecycle_batch_epoch (org_id, producer_run_id) WHERE status = 'sealed';
  CREATE INDEX IF NOT EXISTS lifecycle_batch_epoch_run_idx
    ON lifecycle_batch_epoch (org_id, producer_run_id);

  CREATE TABLE IF NOT EXISTS lifecycle_batch_disposition (
    id                  text PRIMARY KEY,
    epoch_id            text NOT NULL REFERENCES lifecycle_batch_epoch(id) ON DELETE CASCADE,
    aggregate           text NOT NULL
                          CHECK (aggregate IN ('approved','changes_requested','rejected','partially_approved')),
    terminal            boolean NOT NULL,
    effects_releasable  boolean NOT NULL,
    repair_scope        jsonb NOT NULL DEFAULT '[]'::jsonb,
    union_findings      jsonb NOT NULL DEFAULT '[]'::jsonb,
    per_target_outcomes jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT lifecycle_batch_disposition_epoch_uniq UNIQUE (epoch_id)
  );

  CREATE TABLE IF NOT EXISTS lifecycle_repair (
    id                                   text PRIMARY KEY,
    lineage_id                           text NOT NULL,
    gate_id                              text NOT NULL,
    org_id                               text NOT NULL,
    producer_run_id                      text,
    producer_agent_id                    text,
    base_artifact_id                     text NOT NULL,
    base_representation_revision_id      text NOT NULL,
    expected_base_revision_id            text NOT NULL,
    findings                             jsonb NOT NULL,
    continuation_mode                    text NOT NULL
                                           CHECK (continuation_mode IN ('checkpointed','async_effects_gated')),
    continuation_address                 text,
    attempt                              integer NOT NULL,
    route                                text NOT NULL
                                           CHECK (route IN ('producer_repair','org_repair_route','human_escalation')),
    status                               text NOT NULL DEFAULT 'requested'
                                           CHECK (status IN ('requested','dispatched','repaired','stale','escalated','superseded')),
    successor_gate_id                    text,
    successor_artifact_id                text,
    successor_representation_revision_id text,
    finding_outcomes                     jsonb,
    change_summary                       text,
    idempotency_key                      text NOT NULL,
    created_at                           timestamptz NOT NULL DEFAULT now(),
    updated_at                           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT lifecycle_repair_gate_uniq UNIQUE (gate_id)
  );
  CREATE INDEX IF NOT EXISTS lifecycle_repair_lineage_idx ON lifecycle_repair (lineage_id);
  CREATE INDEX IF NOT EXISTS lifecycle_repair_status_idx ON lifecycle_repair (status, created_at);

  CREATE TABLE IF NOT EXISTS run_rejected_recommendations (
    id                    text PRIMARY KEY,
    run_id                text NOT NULL,
    skill_id              text NOT NULL,
    skill_revision_id     text,
    recommendation_source text NOT NULL,
    recommended_rank      integer,
    created_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT run_rejected_recommendations_uniq UNIQUE (run_id, skill_id)
  );
  CREATE INDEX IF NOT EXISTS run_rejected_recommendations_run_idx
    ON run_rejected_recommendations (run_id);
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(lifecycleRepairDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Drop the fresh tables (children before parents; indexes ride the drops) and
  // revert the CHECK-expansions to the S0 vocabulary. HONEST COST: repair /
  // batch-epoch / rejected-recommendation rows are lost, and a resolved
  // 'changes_requested' gate would violate the reverted CHECK — accepted by --down.
  pgm.sql(`
    DROP TABLE IF EXISTS run_rejected_recommendations;
    DROP TABLE IF EXISTS lifecycle_repair;
    DROP TABLE IF EXISTS lifecycle_batch_disposition;
    DROP TABLE IF EXISTS lifecycle_batch_epoch;

    ALTER TABLE artifact_review_audit DROP CONSTRAINT IF EXISTS artifact_review_audit_disposition_check;
    ALTER TABLE artifact_review_audit ADD CONSTRAINT artifact_review_audit_disposition_check
      CHECK (disposition IN ('approve','reject','comment'));
    ALTER TABLE artifact_review_gates DROP CONSTRAINT IF EXISTS artifact_review_gates_resolved_chk;
    ALTER TABLE artifact_review_gates ADD CONSTRAINT artifact_review_gates_resolved_chk CHECK (
      status = 'pending'
      OR (disposition IN ('approve','reject') AND fingerprint IS NOT NULL AND resolved_at IS NOT NULL)
    );
    ALTER TABLE artifact_review_gates DROP CONSTRAINT IF EXISTS artifact_review_gates_disposition_check;
    ALTER TABLE artifact_review_gates ADD CONSTRAINT artifact_review_gates_disposition_check
      CHECK (disposition IN ('approve','reject'));
  `);
}
