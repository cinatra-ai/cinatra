// core__0079 — lifecycle-interceptions S0 foundation store (cinatra#2038, epic
// #2037) — the operator-upgrade twin of the fresh-install bootstrap DDL
// (lifecycleInterceptionsSchemaQueries) co-located in the already route-reachable
// src/lib/artifacts/artifact-review-gate-schema.ts and spread into
// buildCreateStoreSchemaQueries in the SAME PR.
//
// FOUNDATION SLICE — no consumers ship here. Every schema/contract later slices
// (S1–S7b) depend on is landed here, fenced. Nine brand-new tables + additive
// gate-store extensions + one compiled-config column:
//
//   lifecycle_policy_rules         — org policy LATTICE bounds (required/forbidden)
//                                    per (checkpoint, artifact type, destination
//                                    class, origin kind); absence of a row =
//                                    'silent' (unconstrained), never stored.
//   artifact_produced_outbox       — the transactional ArtifactProduced event
//                                    (event_id PK = deterministic sha256 of the
//                                    gate key, so a same-tx re-emit under replay is
//                                    idempotent), enumerated emitter, continuation
//                                    mode/address, + a (artifact,revision,kind)
//                                    UNIQUE so the deterministic id and the tuple
//                                    agree.
//   lifecycle_continuation_park    — checkpointed-mode park records
//                                    (evaluate-then-park): policy-decision id,
//                                    protected effect, reevaluation intent, a TTL
//                                    that always-resumes into a terminal
//                                    policy_unresolved block.
//   gate_advisory_comments         — the zero-authority advisory seam: gate-bound
//                                    (FK CASCADE), provenance-stamped, idempotent
//                                    per (gate, key), DECISION-FREE (no decision
//                                    columns exist).
//   artifact_verification_records  — DECIDED SCHEMA (S4).
//   run_selected_skill_revisions   — DECIDED SCHEMA (S3).
//   cms_snapshot_targets           — DECIDED SCHEMA (S5).
//   gate_suggestion_snapshots +
//   suggestion_decision_ledger     — DECIDED SCHEMA (S4 auditor re-home).
//
// GATE-STORE EXTENSIONS (additive ALTERs on the #1796 review-gate tables):
//   artifact_review_gates.expires_at / reopen_count
//   artifact_review_resume_outbox.max_attempts / dead_lettered_at / last_error
//     (+ a partial dead-letter index) — the resume drain dead-letters an
//     exhausted intent instead of re-leasing it forever (ops-surfaced).
//   agent_templates.lifecycle_config — the compiled agent-manifest lifecycle
//     declarations (JSON-as-text), trigger-style (mirrors trigger_mode /
//     gated_steps).
//
// NO foreign keys to agent_runs ON PURPOSE (the review-gate precedent): rows are
// keyed by run/gate ids validated at write time and outlive run-row churn. The
// advisory / verification / suggestion rows FK to artifact_review_gates(id) ON
// DELETE CASCADE (meaningless without their gate); the ledger FKs the snapshot.
//
// ADDITIVE + IDEMPOTENT — the DDL MIRRORS the bootstrap leaf exactly (CREATE …
// IF NOT EXISTS, ADD COLUMN IF NOT EXISTS): a no-op on a bootstrap-seeded schema,
// ledger-faked on a fresh install, executed by db migrate on an existing
// deployment. Unqualified names ride the runner's search_path (the app schema).
// metadata-only DDL over empty/additive tables; no noTransaction().
//
// SEQ 0079 — strictly greater than the max shipped seq on origin/main (core__0077,
// from the merged #1986 assistant-pause set) AND the in-flight open PR #2049's
// claimed core__0078. A concurrent lane may land the next seq first, in which case
// a rename-only renumber is normal (FLAGGED for the coordinator's train).
// migrations/** is HIGH-RISK: owner approval required; the lane never merges.
//
// DOWN. Drops the nine fresh tables (children before parents) and the added
// columns/indexes. HONEST COST: any lifecycle policy rows / produced events /
// parks / advisory comments are lost — an operator --down accepts that (the
// tables carry no data on a fresh install; nothing consumes them at S0).

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it. */
export const lifecycleInterceptionsDdlSql = `
  CREATE TABLE IF NOT EXISTS lifecycle_policy_rules (
    id                text PRIMARY KEY,
    org_id            text NOT NULL,
    checkpoint        text NOT NULL CHECK (checkpoint IN ('recommendation','review','verification')),
    artifact_type     text NOT NULL,
    destination_class text NOT NULL CHECK (destination_class IN ('none','external_publish','visibility_promotion','pipeline_handoff')),
    origin_kind       text NOT NULL CHECK (origin_kind IN ('agent_produced','user_provided','intermediate')),
    bound             text NOT NULL CHECK (bound IN ('required','forbidden')),
    self_approval_opt_in boolean NOT NULL DEFAULT false,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_policy_rules_key_uniq
    ON lifecycle_policy_rules (org_id, checkpoint, artifact_type, destination_class, origin_kind);
  CREATE INDEX IF NOT EXISTS lifecycle_policy_rules_org_idx
    ON lifecycle_policy_rules (org_id);

  CREATE TABLE IF NOT EXISTS artifact_produced_outbox (
    event_id                   text PRIMARY KEY,
    org_id                     text NOT NULL,
    artifact_id                text NOT NULL,
    representation_revision_id text NOT NULL,
    event_kind                 text NOT NULL DEFAULT 'artifact_produced'
                                 CHECK (event_kind IN ('artifact_produced')),
    emitter                    text NOT NULL
                                 CHECK (emitter IN ('createSemanticArtifact','dashboard_twin_writer','object_cms_snapshot_capture')),
    producer_run_id            text,
    producer_agent_id          text,
    origin_kind                text NOT NULL CHECK (origin_kind IN ('agent_produced','user_provided','intermediate')),
    destination_class          text NOT NULL CHECK (destination_class IN ('none','external_publish','visibility_promotion','pipeline_handoff')),
    continuation_mode          text NOT NULL CHECK (continuation_mode IN ('checkpointed','async_effects_gated')),
    continuation_address       text,
    status                     text NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending','processed','reconciled')),
    created_at                 timestamptz NOT NULL DEFAULT now(),
    processed_at               timestamptz,
    CONSTRAINT artifact_produced_outbox_revision_uniq UNIQUE (artifact_id, representation_revision_id, event_kind)
  );
  CREATE INDEX IF NOT EXISTS artifact_produced_outbox_status_idx
    ON artifact_produced_outbox (status, created_at);
  CREATE INDEX IF NOT EXISTS artifact_produced_outbox_org_idx
    ON artifact_produced_outbox (org_id);

  CREATE TABLE IF NOT EXISTS lifecycle_continuation_park (
    id                   text PRIMARY KEY,
    run_id               text NOT NULL,
    event_id             text NOT NULL,
    checkpoint           text NOT NULL CHECK (checkpoint IN ('recommendation','review','verification')),
    policy_decision_id   text,
    protected_effect     text NOT NULL CHECK (protected_effect IN ('none','external_publish','visibility_promotion','pipeline_handoff')),
    reevaluation_intent  boolean NOT NULL DEFAULT false,
    status               text NOT NULL DEFAULT 'parked'
                           CHECK (status IN ('parked','released','policy_unresolved')),
    ttl_expires_at       timestamptz NOT NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),
    resolved_at          timestamptz,
    CONSTRAINT lifecycle_continuation_park_run_event_uniq UNIQUE (run_id, event_id, checkpoint)
  );
  CREATE INDEX IF NOT EXISTS lifecycle_continuation_park_due_idx
    ON lifecycle_continuation_park (status, ttl_expires_at);

  CREATE TABLE IF NOT EXISTS gate_advisory_comments (
    id              text PRIMARY KEY,
    gate_id         text NOT NULL REFERENCES artifact_review_gates(id) ON DELETE CASCADE,
    author_id       text NOT NULL,
    author_kind     text NOT NULL CHECK (author_kind IN ('user','agent','service')),
    body            text NOT NULL,
    idempotency_key text NOT NULL,
    run_causation   text,
    created_at      timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS gate_advisory_comments_idem_uniq
    ON gate_advisory_comments (gate_id, idempotency_key);
  CREATE INDEX IF NOT EXISTS gate_advisory_comments_gate_idx
    ON gate_advisory_comments (gate_id, created_at);

  CREATE TABLE IF NOT EXISTS artifact_verification_records (
    id                                  text PRIMARY KEY,
    gate_id                             text NOT NULL REFERENCES artifact_review_gates(id) ON DELETE CASCADE,
    reviewed_artifact_id                text NOT NULL,
    reviewed_representation_revision_id text NOT NULL,
    repaired_artifact_id                text NOT NULL,
    repaired_representation_revision_id text NOT NULL,
    scope_manifest                      jsonb NOT NULL DEFAULT '{"paths":[]}'::jsonb,
    field_diff                          jsonb NOT NULL DEFAULT '[]'::jsonb,
    visual_diff                         jsonb,
    outcome                             text NOT NULL CHECK (outcome IN ('verified','drifted','unmet')),
    created_at                          timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS artifact_verification_records_gate_idx
    ON artifact_verification_records (gate_id);

  CREATE TABLE IF NOT EXISTS run_selected_skill_revisions (
    id                text PRIMARY KEY,
    run_id            text NOT NULL,
    skill_id          text NOT NULL,
    skill_revision_id text NOT NULL,
    selection_source  text NOT NULL,
    selected_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT run_selected_skill_revisions_uniq UNIQUE (run_id, skill_id)
  );
  CREATE INDEX IF NOT EXISTS run_selected_skill_revisions_run_idx
    ON run_selected_skill_revisions (run_id);

  CREATE TABLE IF NOT EXISTS cms_snapshot_targets (
    id                     text PRIMARY KEY,
    artifact_id            text NOT NULL,
    snapshot_revision_id   text NOT NULL,
    scope_manifest         jsonb NOT NULL DEFAULT '{"paths":[]}'::jsonb,
    connector_instance     text NOT NULL,
    resource_type          text NOT NULL,
    resource_id            text,
    base_remote_revision_ref text,
    operation_id           text NOT NULL,
    created_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cms_snapshot_targets_operation_uniq UNIQUE (operation_id)
  );
  CREATE INDEX IF NOT EXISTS cms_snapshot_targets_artifact_idx
    ON cms_snapshot_targets (artifact_id);

  CREATE TABLE IF NOT EXISTS gate_suggestion_snapshots (
    id         text PRIMARY KEY,
    gate_id    text NOT NULL REFERENCES artifact_review_gates(id) ON DELETE CASCADE,
    payload    jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS gate_suggestion_snapshots_gate_idx
    ON gate_suggestion_snapshots (gate_id);

  CREATE TABLE IF NOT EXISTS suggestion_decision_ledger (
    id            text PRIMARY KEY,
    suggestion_id text NOT NULL REFERENCES gate_suggestion_snapshots(id) ON DELETE CASCADE,
    gate_id       text NOT NULL,
    decision      text NOT NULL CHECK (decision IN ('applied','dismissed')),
    decided_by    text NOT NULL,
    decided_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT suggestion_decision_ledger_uniq UNIQUE (suggestion_id)
  );

  -- Gate-store extensions (additive ALTERs on the #1796 review-gate tables).
  ALTER TABLE artifact_review_gates ADD COLUMN IF NOT EXISTS expires_at timestamptz;
  ALTER TABLE artifact_review_gates ADD COLUMN IF NOT EXISTS reopen_count integer NOT NULL DEFAULT 0;
  ALTER TABLE artifact_review_resume_outbox ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 20;
  ALTER TABLE artifact_review_resume_outbox ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz;
  ALTER TABLE artifact_review_resume_outbox ADD COLUMN IF NOT EXISTS last_error text;
  CREATE INDEX IF NOT EXISTS artifact_review_resume_outbox_dead_idx
    ON artifact_review_resume_outbox (dead_lettered_at) WHERE dead_lettered_at IS NOT NULL;

  -- Compiled agent-manifest lifecycle declarations (JSON-as-text).
  ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS lifecycle_config text;
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(lifecycleInterceptionsDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible in shape: drop the fresh tables (children before parents; indexes
  // ride the drops) and the added columns/indexes. HONEST COST: any lifecycle
  // policy / produced-event / park / advisory rows are lost — an operator --down
  // accepts that (empty on a fresh install; nothing consumes them at S0).
  pgm.sql(`
    DROP TABLE IF EXISTS suggestion_decision_ledger;
    DROP TABLE IF EXISTS gate_suggestion_snapshots;
    DROP TABLE IF EXISTS cms_snapshot_targets;
    DROP TABLE IF EXISTS run_selected_skill_revisions;
    DROP TABLE IF EXISTS artifact_verification_records;
    DROP TABLE IF EXISTS gate_advisory_comments;
    DROP TABLE IF EXISTS lifecycle_continuation_park;
    DROP TABLE IF EXISTS artifact_produced_outbox;
    DROP TABLE IF EXISTS lifecycle_policy_rules;

    DROP INDEX IF EXISTS artifact_review_resume_outbox_dead_idx;
    ALTER TABLE artifact_review_resume_outbox DROP COLUMN IF EXISTS last_error;
    ALTER TABLE artifact_review_resume_outbox DROP COLUMN IF EXISTS dead_lettered_at;
    ALTER TABLE artifact_review_resume_outbox DROP COLUMN IF EXISTS max_attempts;
    ALTER TABLE artifact_review_gates DROP COLUMN IF EXISTS reopen_count;
    ALTER TABLE artifact_review_gates DROP COLUMN IF EXISTS expires_at;
    ALTER TABLE agent_templates DROP COLUMN IF EXISTS lifecycle_config;
  `);
}
