// Bootstrap DDL for the generic ARTIFACT-REVIEW GATE store (cinatra#1796, epic
// #1620 S13) — the persistence the #1795/#1807 pure cores were fenced against.
//
// #1807 shipped the pure cores (the immutable review-target contract, the
// preparation core, and the DECISION core with its one-transaction commit
// contract) but deliberately deferred BOTH the gate-EMISSION side that PINS the
// targets and the LIVE decision-submit binder to this slice (the reviewer-
// generalization #1796 that owns the emitting gate). This leaf introduces the
// four tables that back that contract end-to-end:
//
//   `artifact_review_gates` — ONE row per (run_id, review_task_id). Created
//     (PINNED) by the emitting gate with the frozen `{artifactId,
//     representationRevisionId}` target set resolved once at gate creation
//     (`status='pending'`), then CAS-resolved by a terminal decision
//     (`status='resolved'` + the idempotency `fingerprint` + the `disposition`).
//     The UNIQUE (run_id, review_task_id) makes emit idempotent and is the
//     pending-gate anchor the preparation + decision cores read + CAS against.
//
//   `artifact_review_audit` — ONE row per reviewed revision per decision. Carries
//     the reviewed revision + the HOST-DERIVED renderer provenance (kind /
//     package / digest — re-resolved from the artifact TYPE at submit, never a
//     client claim; AC-3 "audit rows carry revision + renderer provenance"). The
//     UNIQUE (gate_id, decision_fingerprint, artifact_id, representation_revision_id)
//     makes the audit insert idempotent under a response-lost retry (the same
//     decision re-drives no duplicate rows).
//
//   `artifact_review_dispositions` — the durable reject→TOMBSTONE disposition
//     record (the union kind admits ONLY 'tombstone'; a review can never
//     hard-delete). `applied_at` NULL ⇒ pending downstream application (the
//     tombstone lands on the separate objects store via `tombstoneArtifact`, so
//     it cannot ride THIS store's transaction; the record is the drainable
//     intent). UNIQUE (gate_id, artifact_id, representation_revision_id) keeps a
//     retry from double-recording.
//
//   `artifact_review_resume_outbox` — the terminal RESUME intent, persisted
//     EXACTLY ONCE (PK `gate_id` so a resolved gate carries AT MOST ONE resume —
//     no resolved-but-unresumed stranding and no double-persist). `kind` is
//     discriminated ('approve' | 'reject') so a reject can never be drained down
//     the approve wire; `response_text` is the pre-serialized WayFlow resume text.
//     A lease (`lease_token` + `lease_expires_at`, `attempts`) SERIALIZES the
//     delivery worker's drain (the 0071 outbox-lease precedent). NB: the intent
//     is exactly-once PERSISTED but DELIVERY is AT-LEAST-ONCE (a send-then-crash
//     redelivers on lease expiry), so the downstream resume consumer must be
//     idempotent per gate.
//
// NO foreign keys to agent_runs ON PURPOSE (the auditor-review-companion /
// publication-operation precedent): the gate is keyed by the run id (validated at
// WRITE time by the emitting gate's run-access guard, not FK-pinned) and must
// outlive run-row churn. The three child tables DO FK to
// `artifact_review_gates(id) ON DELETE CASCADE` — they are meaningless without
// their gate and a gate teardown must take its audit/disposition/outbox with it,
// which keeps this leaf self-contained (no cross-block bootstrap ordering).
//
// ADDITIVE (four brand-new empty tables + their indexes) — no artifact is
// REQUIRED. The DDL MIRRORS core__0072 exactly (idempotent CREATE … IF NOT
// EXISTS), so it is a no-op on a bootstrap-seeded schema, ledger-faked on a fresh
// install, and executed by `db migrate` on an existing deployment. Unqualified
// names in the migration ride the runner's search_path (the app schema); here the
// names are schema-qualified for the bootstrap path.

type QueryInput = { text: string; values?: unknown[] };

export function artifactReviewGateSchemaQueries(schemaName: string): QueryInput[] {
  const q = schemaName.replaceAll('"', '""'); // identifier
  return [
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."artifact_review_gates" (
  id              text PRIMARY KEY,
  run_id          text NOT NULL,
  org_id          text NOT NULL,
  review_task_id  text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','resolved')),
  pinned_targets  jsonb NOT NULL,
  -- Only a TERMINAL disposition ever lands on the gate (a 'comment' is
  -- audit-only and never resolves the gate).
  disposition     text CHECK (disposition IN ('approve','reject')),
  fingerprint     text,
  resolved_by     text,
  resolved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- A resolved gate MUST carry the terminal disposition + idempotency
  -- fingerprint + resolution time the CAS stamps; a pending gate carries none.
  CONSTRAINT artifact_review_gates_resolved_chk CHECK (
    status = 'pending'
    OR (disposition IN ('approve','reject') AND fingerprint IS NOT NULL AND resolved_at IS NOT NULL)
  )
)`,
    },
    {
      text: `CREATE UNIQUE INDEX IF NOT EXISTS artifact_review_gates_run_task_uniq
  ON "${q}"."artifact_review_gates" (run_id, review_task_id)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS artifact_review_gates_org_idx
  ON "${q}"."artifact_review_gates" (org_id)`,
    },
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."artifact_review_audit" (
  id                         text PRIMARY KEY,
  gate_id                    text NOT NULL
                               REFERENCES "${q}"."artifact_review_gates" (id) ON DELETE CASCADE,
  run_id                     text NOT NULL,
  review_task_id             text NOT NULL,
  decision_fingerprint       text NOT NULL,
  artifact_id                text NOT NULL,
  representation_revision_id text NOT NULL,
  disposition                text NOT NULL CHECK (disposition IN ('approve','reject','comment')),
  renderer_kind              text NOT NULL CHECK (renderer_kind IN ('build-map','runtime','floor')),
  renderer_package           text,
  renderer_digest            text,
  created_at                 timestamptz NOT NULL DEFAULT now()
)`,
    },
    {
      text: `CREATE UNIQUE INDEX IF NOT EXISTS artifact_review_audit_row_uniq
  ON "${q}"."artifact_review_audit" (gate_id, decision_fingerprint, artifact_id, representation_revision_id)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS artifact_review_audit_gate_idx
  ON "${q}"."artifact_review_audit" (gate_id)`,
    },
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."artifact_review_dispositions" (
  id                         text PRIMARY KEY,
  gate_id                    text NOT NULL
                               REFERENCES "${q}"."artifact_review_gates" (id) ON DELETE CASCADE,
  org_id                     text NOT NULL,
  run_id                     text NOT NULL,
  artifact_id                text NOT NULL,
  representation_revision_id text NOT NULL,
  kind                       text NOT NULL CHECK (kind IN ('tombstone')),
  applied_at                 timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now()
)`,
    },
    {
      text: `CREATE UNIQUE INDEX IF NOT EXISTS artifact_review_dispositions_uniq
  ON "${q}"."artifact_review_dispositions" (gate_id, artifact_id, representation_revision_id)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS artifact_review_dispositions_pending_idx
  ON "${q}"."artifact_review_dispositions" (created_at) WHERE applied_at IS NULL`,
    },
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."artifact_review_resume_outbox" (
  gate_id          text PRIMARY KEY
                     REFERENCES "${q}"."artifact_review_gates" (id) ON DELETE CASCADE,
  run_id           text NOT NULL,
  review_task_id   text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('approve','reject')),
  response_text    text NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','delivering','done')),
  attempts         integer NOT NULL DEFAULT 0,
  lease_token      text,
  lease_expires_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS artifact_review_resume_outbox_status_idx
  ON "${q}"."artifact_review_resume_outbox" (status, created_at)`,
    },
  ];
}

// ---------------------------------------------------------------------------
// lifecycle-interceptions S0 (cinatra#2038, epic #2037) bootstrap DDL.
// Co-located in this already-route-reachable schema module (rather than a
// standalone leaf under src/lib/lifecycle/) so drizzle-store gains NO new
// first-party node in any tracked route's reachable graph (the route-graph
// dev-perf ratchet), while keeping drizzle-store under the file-size ratchet.
// S0 builds the lifecycle-interception substrate ON the #1796 artifact-review
// gate above: the gate-store EXTENSIONS below ALTER the artifact_review_gates
// + resume-outbox tables defined in artifactReviewGateSchemaQueries. The
// operator-upgrade twin is migration core__0079; the two DDLs mirror each other.
// ---------------------------------------------------------------------------
export function lifecycleInterceptionsSchemaQueries(schemaName: string): QueryInput[] {
  const q = schemaName.replaceAll('"', '""'); // identifier
  return [
    // -----------------------------------------------------------------------
    // Policy lattice — org bounds.
    // -----------------------------------------------------------------------
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."lifecycle_policy_rules" (
  id                text PRIMARY KEY,
  org_id            text NOT NULL,
  checkpoint        text NOT NULL CHECK (checkpoint IN ('recommendation','review','verification')),
  artifact_type     text NOT NULL,
  destination_class text NOT NULL CHECK (destination_class IN ('none','external_publish','visibility_promotion','pipeline_handoff')),
  origin_kind       text NOT NULL CHECK (origin_kind IN ('agent_produced','user_provided','intermediate')),
  -- Only bounds are STORED; the absence of a row IS 'silent' (unconstrained).
  bound             text NOT NULL CHECK (bound IN ('required','forbidden')),
  -- Org opt-in relaxing SoD self-approval on a 'required' gate (default off).
  self_approval_opt_in boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
)`,
    },
    {
      text: `CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_policy_rules_key_uniq
  ON "${q}"."lifecycle_policy_rules" (org_id, checkpoint, artifact_type, destination_class, origin_kind)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS lifecycle_policy_rules_org_idx
  ON "${q}"."lifecycle_policy_rules" (org_id)`,
    },

    // -----------------------------------------------------------------------
    // ArtifactProduced outbox.
    // -----------------------------------------------------------------------
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."artifact_produced_outbox" (
  -- DETERMINISTIC id = sha256(artifact_id, representation_revision_id, event_kind)
  -- so a same-tx re-emit under replay lands on THIS row (idempotent).
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
  -- Processing status of the produced-event handoff to S1 orchestration.
  status                     text NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','processed','reconciled')),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  processed_at               timestamptz,
  CONSTRAINT artifact_produced_outbox_revision_uniq UNIQUE (artifact_id, representation_revision_id, event_kind)
)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS artifact_produced_outbox_status_idx
  ON "${q}"."artifact_produced_outbox" (status, created_at)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS artifact_produced_outbox_org_idx
  ON "${q}"."artifact_produced_outbox" (org_id)`,
    },

    // -----------------------------------------------------------------------
    // Continuation park (checkpointed mode).
    // -----------------------------------------------------------------------
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."lifecycle_continuation_park" (
  id                   text PRIMARY KEY,
  run_id               text NOT NULL,
  event_id             text NOT NULL,
  checkpoint           text NOT NULL CHECK (checkpoint IN ('recommendation','review','verification')),
  -- The policy decision that PARKED the run (provenance for the bypass-resume).
  policy_decision_id   text,
  -- The protected effect the park guards (drives the TTL fail-closed block).
  protected_effect     text NOT NULL CHECK (protected_effect IN ('none','external_publish','visibility_promotion','pipeline_handoff')),
  reevaluation_intent  boolean NOT NULL DEFAULT false,
  status               text NOT NULL DEFAULT 'parked'
                         CHECK (status IN ('parked','released','policy_unresolved')),
  -- TTL: a parked run ALWAYS resumes by this deadline (terminal policy_unresolved
  -- on the protected effect when unresolved).
  ttl_expires_at       timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  resolved_at          timestamptz,
  CONSTRAINT lifecycle_continuation_park_run_event_uniq UNIQUE (run_id, event_id, checkpoint)
)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS lifecycle_continuation_park_due_idx
  ON "${q}"."lifecycle_continuation_park" (status, ttl_expires_at)`,
    },

    // -----------------------------------------------------------------------
    // Advisory seam (zero-authority, decision-free, gate-bound).
    // -----------------------------------------------------------------------
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."gate_advisory_comments" (
  id              text PRIMARY KEY,
  gate_id         text NOT NULL
                    REFERENCES "${q}"."artifact_review_gates" (id) ON DELETE CASCADE,
  author_id       text NOT NULL,
  author_kind     text NOT NULL CHECK (author_kind IN ('user','agent','service')),
  body            text NOT NULL,
  idempotency_key text NOT NULL,
  run_causation   text,
  created_at      timestamptz NOT NULL DEFAULT now()
)`,
    },
    {
      text: `CREATE UNIQUE INDEX IF NOT EXISTS gate_advisory_comments_idem_uniq
  ON "${q}"."gate_advisory_comments" (gate_id, idempotency_key)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS gate_advisory_comments_gate_idx
  ON "${q}"."gate_advisory_comments" (gate_id, created_at)`,
    },

    // -----------------------------------------------------------------------
    // DECIDED SCHEMA — verification records (S4).
    // -----------------------------------------------------------------------
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."artifact_verification_records" (
  id                                  text PRIMARY KEY,
  gate_id                             text NOT NULL
                                        REFERENCES "${q}"."artifact_review_gates" (id) ON DELETE CASCADE,
  reviewed_artifact_id                text NOT NULL,
  reviewed_representation_revision_id text NOT NULL,
  repaired_artifact_id                text NOT NULL,
  repaired_representation_revision_id text NOT NULL,
  scope_manifest                      jsonb NOT NULL DEFAULT '{"paths":[]}'::jsonb,
  field_diff                          jsonb NOT NULL DEFAULT '[]'::jsonb,
  visual_diff                         jsonb,
  outcome                             text NOT NULL CHECK (outcome IN ('verified','drifted','unmet')),
  created_at                          timestamptz NOT NULL DEFAULT now()
)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS artifact_verification_records_gate_idx
  ON "${q}"."artifact_verification_records" (gate_id)`,
    },

    // -----------------------------------------------------------------------
    // DECIDED SCHEMA — per-run selected skill-revision sets (S3).
    // -----------------------------------------------------------------------
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."run_selected_skill_revisions" (
  id                text PRIMARY KEY,
  run_id            text NOT NULL,
  skill_id          text NOT NULL,
  skill_revision_id text NOT NULL,
  selection_source  text NOT NULL,
  selected_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_selected_skill_revisions_uniq UNIQUE (run_id, skill_id)
)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS run_selected_skill_revisions_run_idx
  ON "${q}"."run_selected_skill_revisions" (run_id)`,
    },

    // -----------------------------------------------------------------------
    // DECIDED SCHEMA — CMS snapshot-as-target + apply binding (S5).
    // -----------------------------------------------------------------------
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."cms_snapshot_targets" (
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
)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS cms_snapshot_targets_artifact_idx
  ON "${q}"."cms_snapshot_targets" (artifact_id)`,
    },

    // -----------------------------------------------------------------------
    // DECIDED SCHEMA — gate-bound suggestion snapshots + decision ledger (S4).
    // -----------------------------------------------------------------------
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."gate_suggestion_snapshots" (
  id         text PRIMARY KEY,
  gate_id    text NOT NULL
               REFERENCES "${q}"."artifact_review_gates" (id) ON DELETE CASCADE,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS gate_suggestion_snapshots_gate_idx
  ON "${q}"."gate_suggestion_snapshots" (gate_id)`,
    },
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."suggestion_decision_ledger" (
  id            text PRIMARY KEY,
  suggestion_id text NOT NULL
                  REFERENCES "${q}"."gate_suggestion_snapshots" (id) ON DELETE CASCADE,
  gate_id       text NOT NULL,
  decision      text NOT NULL CHECK (decision IN ('applied','dismissed')),
  decided_by    text NOT NULL,
  decided_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT suggestion_decision_ledger_uniq UNIQUE (suggestion_id)
)`,
    },

    // -----------------------------------------------------------------------
    // GATE-STORE EXTENSIONS — additive ALTERs on the #1796 review-gate tables.
    // Run AFTER artifactReviewGateSchemaQueries (the tables must exist).
    // -----------------------------------------------------------------------
    { text: `ALTER TABLE "${q}"."artifact_review_gates" ADD COLUMN IF NOT EXISTS expires_at timestamptz` },
    { text: `ALTER TABLE "${q}"."artifact_review_gates" ADD COLUMN IF NOT EXISTS reopen_count integer NOT NULL DEFAULT 0` },
    { text: `ALTER TABLE "${q}"."artifact_review_resume_outbox" ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 20` },
    { text: `ALTER TABLE "${q}"."artifact_review_resume_outbox" ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz` },
    { text: `ALTER TABLE "${q}"."artifact_review_resume_outbox" ADD COLUMN IF NOT EXISTS last_error text` },
    {
      text: `CREATE INDEX IF NOT EXISTS artifact_review_resume_outbox_dead_idx
  ON "${q}"."artifact_review_resume_outbox" (dead_lettered_at) WHERE dead_lettered_at IS NOT NULL`,
    },

    // -----------------------------------------------------------------------
    // COMPILED MANIFEST — agent_templates.lifecycle_config (JSON-as-text).
    // -----------------------------------------------------------------------
    { text: `ALTER TABLE "${q}"."agent_templates" ADD COLUMN IF NOT EXISTS lifecycle_config text` },
  ];
}
