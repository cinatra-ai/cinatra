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
  -- audit-only and never resolves the gate). S2 (cinatra#2040) adds
  -- 'changes_requested' as a terminal disposition that closes the review attempt
  -- and opens a repair (its effect stays HELD until the successor gate approves).
  disposition     text CHECK (disposition IN ('approve','reject','changes_requested')),
  fingerprint     text,
  resolved_by     text,
  resolved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- A resolved gate MUST carry the terminal disposition + idempotency
  -- fingerprint + resolution time the CAS stamps; a pending gate carries none.
  CONSTRAINT artifact_review_gates_resolved_chk CHECK (
    status = 'pending'
    OR (disposition IN ('approve','reject','changes_requested') AND fingerprint IS NOT NULL AND resolved_at IS NOT NULL)
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
  disposition                text NOT NULL CHECK (disposition IN ('approve','reject','comment','changes_requested')),
  renderer_kind              text NOT NULL CHECK (renderer_kind IN ('build-map','runtime','first-party','floor')),
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
  -- INERT (cinatra#2047, row-3 re-scope): never read, never written; kept physically because
  -- dropping it would need a migration. A bound says whether a review is required, not who decides.
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
  -- The closed emitter set. object_snapshot_mint is the object-backed
  -- contract's mint (enabler 0.13 of PLAN: Agents Lifecycle (C),
  -- cinatra#3028); the operator-upgrade twin of this widen is core__0099.
  emitter                    text NOT NULL
                               CHECK (emitter IN ('createSemanticArtifact','dashboard_twin_writer','object_cms_snapshot_capture','object_snapshot_mint','artifact_revision_append')),
  producer_run_id            text,
  producer_agent_id          text,
  origin_kind                text NOT NULL CHECK (origin_kind IN ('agent_produced','user_provided','intermediate')),
  destination_class          text NOT NULL CHECK (destination_class IN ('none','external_publish','visibility_promotion','pipeline_handoff')),
  continuation_mode          text NOT NULL CHECK (continuation_mode IN ('checkpointed','async_effects_gated')),
  continuation_address       text,
  -- Processing status of the produced-event handoff to S1 orchestration.
  status                     text NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','processed','reconciled')),
  -- The producing extension and its PINNED version, beside the run
  -- (cinatra#3029, plan §8.2: "gains the producing extension and its pinned
  -- version beside the run, for a mid-run write made by an embedded agent: the
  -- datum the repair road of the sibling plan reads"). Nullable — an emitter
  -- that cannot name one records NULL rather than a guess.
  producing_extension          text,
  producing_extension_version  text,
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

    // -----------------------------------------------------------------------
    // HOLD-NOTIFICATION STATE (cinatra#2835) — additive ALTER on the continuation
    // park created above. Migration twin: core__0094.
    //
    // A run-start recommendation hold mints a durable "needs your input"
    // notification, and that row must be gone the moment the park stops being
    // `parked`. The notification lives in `notifications`, written through the
    // host's own connection, so the delete cannot ride the park's status CAS
    // transaction. This column carries the OBLIGATION instead: the enter sets it
    // to 'live' in the same STATEMENT as the INSERT, gated on that INSERT's own
    // RETURNING (cinatra#2838 — the insert can still no-op on its ON CONFLICT DO
    // NOTHING dedupe arbiter, so a guard row alone does not mean a row was
    // written), the CAS leaves it alone, and the sweeper retires it
    // to 'cleared' only after an awaited, successful delete. "Park no longer
    // parked AND hold_notification = 'live'" is therefore a durable, retryable
    // clear obligation — a process that dies mid-clear leaves work for the next
    // sweep instead of a permanently stale bell.
    // -----------------------------------------------------------------------
    {
      text: `ALTER TABLE "${q}"."lifecycle_continuation_park"
  ADD COLUMN IF NOT EXISTS hold_notification text NOT NULL DEFAULT 'none'`,
    },
    // The value domain, asserted at the boundary like the table's other unions
    // (checkpoint / status / protected_effect). Guarded so the bootstrap stays
    // idempotent — ADD CONSTRAINT has no IF NOT EXISTS.
    {
      text: `DO $$ BEGIN
  ALTER TABLE "${q}"."lifecycle_continuation_park"
    ADD CONSTRAINT lifecycle_continuation_park_hold_notification_chk
    CHECK (hold_notification IN ('none','live','cleared'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$`,
    },
    // PARTIAL: only the parks that currently owe a clear are indexed, so the
    // sweeper's drain never scans the append-only park table.
    {
      text: `CREATE INDEX IF NOT EXISTS lifecycle_continuation_park_hold_notify_idx
  ON "${q}"."lifecycle_continuation_park" (hold_notification, status)
  WHERE hold_notification = 'live'`,
    },
    // The drain's RETRY CURSOR (cinatra#2838). The obligation drain used to take an
    // UNORDERED page of `limit` live obligations and merely SKIP the ones whose
    // dispatch failed, leaving them exactly as it found them — so `limit`
    // permanently-failing obligations could hold the page on every pass and
    // everything queued behind them was never attempted at all. The drain now
    // CLAIMS its page ordered by `coalesce(hold_notify_attempted_at, created_at)`
    // ASC and stamps this column in the same statement, so an attempted obligation
    // rotates to the back of the queue before its dispatch is even made: poison
    // delays the rows behind it by a pass, and can never starve them. NULLABLE with
    // no default on purpose — null reads as "never attempted", ordered by the
    // park's creation (how long it has actually waited), and a null default keeps
    // the ADD COLUMN catalog-only on a deployed table.
    {
      text: `ALTER TABLE "${q}"."lifecycle_continuation_park"
  ADD COLUMN IF NOT EXISTS hold_notify_attempted_at timestamptz`,
    },
  ];
}

// ---------------------------------------------------------------------------
// chat-hitl S6b (cinatra#2571, epic #2564) — the suggestion DECISION schema.
//
// Two changes, both on tables the S4 block above creates, so this function is
// spread AFTER it. The operator-upgrade twin is migration core__0092; the two
// DDLs mirror each other.
//
//   suggestion_decision_ledger  — RESHAPED from "one row per snapshot" to "one
//     row per DECIDED SUGGESTION". The shipped shape put the FK + the UNIQUE on
//     `suggestion_id` pointing at `gate_suggestion_snapshots.id`, which admits
//     exactly one row per snapshot — a shape that cannot hold a per-item
//     partition. The table has never had a writer in any release, so this moves
//     no data; the MIGRATION twin additionally refuses to run if it finds a row,
//     rather than silently re-interpreting `suggestion_id` under it.
//
//   suggestion_application_outbox — NEW. The durable application-intent channel,
//     shaped exactly like `artifact_review_resume_outbox` (lease + attempts +
//     max_attempts + dead_lettered_at + last_error) because it carries the same
//     exactly-once-persistence / at-least-once-delivery contract.
//
// Every statement is idempotent (IF EXISTS / IF NOT EXISTS), so a fresh bootstrap
// and a re-run over an already-migrated database behave identically.
// ---------------------------------------------------------------------------

export function suggestionDecisionCasSchemaQueries(schemaName: string): QueryInput[] {
  const q = schemaName.replaceAll('"', '""'); // identifier
  const ledger = `"${q}"."suggestion_decision_ledger"`;
  return [
    // -----------------------------------------------------------------------
    // Ledger reshape. THE ORDER IS THE SAFETY PROPERTY (Codex round 1, finding
    // 4): the ADDITIVE steps and the NOT NULL assertion come FIRST, and only then
    // the destructive drops.
    //
    // Bootstrap DDL runs statement-by-statement in autocommit, and it runs BEFORE
    // the numbered migrations — so the migration's emptiness guard cannot protect
    // it. If the drops came first, a deployment that somehow held legacy ledger
    // rows would lose its old UNIQUE + FK, then fail at `SET NOT NULL`, and be
    // left half-reshaped with the guard never reached. With this order the same
    // deployment fails at `SET NOT NULL` with every original constraint still in
    // place and nothing dropped: fail-closed, and re-runnable once an operator has
    // dealt with the rows.
    // -----------------------------------------------------------------------
    { text: `ALTER TABLE ${ledger} ADD COLUMN IF NOT EXISTS snapshot_id text` },
    { text: `ALTER TABLE ${ledger} ADD COLUMN IF NOT EXISTS decision_fingerprint text` },
    { text: `ALTER TABLE ${ledger} ADD COLUMN IF NOT EXISTS applied_at timestamptz` },
    // The tripwire. On an empty table (every shipped deployment — the table has
    // never had a writer) this succeeds; on a table with legacy rows it raises,
    // BEFORE anything destructive has run.
    { text: `ALTER TABLE ${ledger} ALTER COLUMN snapshot_id SET NOT NULL` },
    { text: `ALTER TABLE ${ledger} ALTER COLUMN decision_fingerprint SET NOT NULL` },

    // Now the destructive half: the one-row-per-snapshot constraints go.
    { text: `ALTER TABLE ${ledger} DROP CONSTRAINT IF EXISTS suggestion_decision_ledger_uniq` },
    { text: `DROP INDEX IF EXISTS "${q}"."suggestion_decision_ledger_uniq"` },
    {
      text: `ALTER TABLE ${ledger} DROP CONSTRAINT IF EXISTS suggestion_decision_ledger_suggestion_id_fkey`,
    },

    // Re-point the foreign keys. DROP IF EXISTS + ADD (rather than a DO block
    // that probes pg_constraint) so every statement here starts with a verb the
    // bootstrap runner and the integration harnesses already execute — the S2
    // CHECK-expansion precedent in `lifecycleRepairSchemaQueries`.
    {
      text: `ALTER TABLE ${ledger} DROP CONSTRAINT IF EXISTS suggestion_decision_ledger_snapshot_id_fkey`,
    },
    {
      text: `ALTER TABLE ${ledger} ADD CONSTRAINT suggestion_decision_ledger_snapshot_id_fkey
  FOREIGN KEY (snapshot_id) REFERENCES "${q}"."gate_suggestion_snapshots" (id) ON DELETE CASCADE`,
    },
    {
      text: `ALTER TABLE ${ledger} DROP CONSTRAINT IF EXISTS suggestion_decision_ledger_gate_id_fkey`,
    },
    {
      text: `ALTER TABLE ${ledger} ADD CONSTRAINT suggestion_decision_ledger_gate_id_fkey
  FOREIGN KEY (gate_id) REFERENCES "${q}"."artifact_review_gates" (id) ON DELETE CASCADE`,
    },
    {
      text: `CREATE UNIQUE INDEX IF NOT EXISTS suggestion_decision_ledger_uniq
  ON ${ledger} (snapshot_id, suggestion_id)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS suggestion_decision_ledger_gate_idx
  ON ${ledger} (gate_id)`,
    },

    // -----------------------------------------------------------------------
    // The application-intent outbox. Mirrors the migration statement for
    // statement, INCLUDING the status CHECK and the snapshot FK (Codex round 1,
    // finding 4 + non-blocking 2): the bootstrap creates the table on a fresh
    // install and the migration's CREATE ... IF NOT EXISTS is then a no-op, so a
    // constraint present in only one of the two would simply never exist.
    // -----------------------------------------------------------------------
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."suggestion_application_outbox" (
  gate_id              text PRIMARY KEY
                         REFERENCES "${q}"."artifact_review_gates" (id) ON DELETE CASCADE,
  run_id               text NOT NULL,
  review_task_id       text NOT NULL,
  snapshot_id          text NOT NULL
                         REFERENCES "${q}"."gate_suggestion_snapshots" (id) ON DELETE CASCADE,
  decision_fingerprint text NOT NULL,
  accepted_ids         jsonb NOT NULL,
  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','delivering','done')),
  attempts             integer NOT NULL DEFAULT 0,
  max_attempts         integer NOT NULL DEFAULT 20,
  lease_token          text,
  lease_expires_at     timestamptz,
  dead_lettered_at     timestamptz,
  last_error           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS suggestion_application_outbox_status_idx
  ON "${q}"."suggestion_application_outbox" (status, created_at)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS suggestion_application_outbox_dead_idx
  ON "${q}"."suggestion_application_outbox" (dead_lettered_at) WHERE dead_lettered_at IS NOT NULL`,
    },
  ];
}

// ---------------------------------------------------------------------------
// lifecycle-interceptions S2 (cinatra#2040, epic #2037) bootstrap DDL — the
// REPAIR LOOP + the two routed schema additions. Co-located in this already-
// route-reachable schema module (the S0 precedent) so drizzle-store gains NO new
// first-party route-graph node. The operator-upgrade twin is migration
// core__0081; the two DDLs mirror each other.
//
// Four brand-new tables + additive CHECK-expansions on the #1796 gate/audit
// tables (so 'changes_requested' is a terminal gate disposition + an audit
// disposition):
//
//   lifecycle_batch_epoch        — the DURABLE sealed-membership epoch that
//                                  REPLACES S1's in-memory seal. The frozen
//                                  membership is persisted BEFORE any gate emit +
//                                  keyed on (org, run, membership_hash), so a
//                                  re-sweep after a crash recovers the FROZEN set
//                                  (never re-snapshots a grown pending set) —
//                                  closing S1's documented crash-window residual.
//   lifecycle_batch_disposition  — the durable per-epoch AGGREGATE disposition
//                                  (approved / changes_requested / rejected /
//                                  partially_approved) S2 owns (S1 left it pure).
//   lifecycle_repair             — the repair LINEAGE: a changes_requested request
//                                  (base target + CAS witness + structured
//                                  findings), the cycle-guard attempt counter, the
//                                  route, and the successor gate + repaired
//                                  revision the producer returns.
//   run_rejected_recommendations — the routed AC-6 rejected-recommendation efficacy
//                                  row (S3 computed it transiently in
//                                  summarizeRecommendationEfficacy and DROPPED it).
//
// The CHECK-expansions are idempotent DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT
// (postgres names a column CHECK `<table>_<column>_check` deterministically), so
// running them on a fresh (already-expanded) schema is a no-op and on an existing
// deployment they widen the constraint. Run AFTER the S0/#1796 gate tables exist.
// ---------------------------------------------------------------------------

export function lifecycleRepairSchemaQueries(schemaName: string): QueryInput[] {
  const q = schemaName.replaceAll('"', '""'); // identifier
  return [
    // -----------------------------------------------------------------------
    // CHECK-expansions on the existing gate/audit tables — 'changes_requested'
    // becomes a terminal gate disposition + an audit disposition.
    // -----------------------------------------------------------------------
    { text: `ALTER TABLE "${q}"."artifact_review_gates" DROP CONSTRAINT IF EXISTS artifact_review_gates_disposition_check` },
    {
      text: `ALTER TABLE "${q}"."artifact_review_gates" ADD CONSTRAINT artifact_review_gates_disposition_check
  CHECK (disposition IN ('approve','reject','changes_requested'))`,
    },
    { text: `ALTER TABLE "${q}"."artifact_review_gates" DROP CONSTRAINT IF EXISTS artifact_review_gates_resolved_chk` },
    {
      text: `ALTER TABLE "${q}"."artifact_review_gates" ADD CONSTRAINT artifact_review_gates_resolved_chk CHECK (
    status = 'pending'
    OR (disposition IN ('approve','reject','changes_requested') AND fingerprint IS NOT NULL AND resolved_at IS NOT NULL)
  )`,
    },
    { text: `ALTER TABLE "${q}"."artifact_review_audit" DROP CONSTRAINT IF EXISTS artifact_review_audit_disposition_check` },
    {
      text: `ALTER TABLE "${q}"."artifact_review_audit" ADD CONSTRAINT artifact_review_audit_disposition_check
  CHECK (disposition IN ('approve','reject','comment','changes_requested'))`,
    },

    // -----------------------------------------------------------------------
    // DURABLE sealed-membership epoch (replaces S1's in-memory seal).
    // -----------------------------------------------------------------------
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."lifecycle_batch_epoch" (
  id               text PRIMARY KEY,
  org_id           text NOT NULL,
  producer_run_id  text NOT NULL,
  -- The DETERMINISTIC content hash of the sealed membership (batchMembershipHash).
  -- A re-seal of the identical membership lands on THIS row (idempotent); a GROWN
  -- membership hashes differently → a distinct SUCCESSOR epoch.
  membership_hash  text NOT NULL,
  -- The FROZEN [{artifactId, representationRevisionId}] set — recovered verbatim on
  -- a re-sweep, never re-snapshotted from a (possibly grown) pending set.
  membership       jsonb NOT NULL,
  target_count     integer NOT NULL,
  -- 'sealed' (frozen, still being partitioned/linked) → 'partitioned' (all members
  -- gated+linked+marked; CLOSED — a new revision seals a successor epoch).
  status           text NOT NULL DEFAULT 'sealed'
                     CHECK (status IN ('sealed','partitioned')),
  sealed_at        timestamptz NOT NULL DEFAULT now(),
  partitioned_at   timestamptz,
  CONSTRAINT lifecycle_batch_epoch_uniq UNIQUE (org_id, producer_run_id, membership_hash)
)`,
    },
    {
      // At most ONE 'sealed' (open) epoch per production — the anchor that stops a
      // re-sweep sealing a NEW epoch over a still-growing production (the frozen
      // epoch is resumed instead). Partial unique index (only 'sealed' rows).
      text: `CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_batch_epoch_open_uniq
  ON "${q}"."lifecycle_batch_epoch" (org_id, producer_run_id) WHERE status = 'sealed'`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS lifecycle_batch_epoch_run_idx
  ON "${q}"."lifecycle_batch_epoch" (org_id, producer_run_id)`,
    },

    // -----------------------------------------------------------------------
    // DURABLE per-epoch AGGREGATE disposition (S2 owns the repair-side aggregate).
    // -----------------------------------------------------------------------
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."lifecycle_batch_disposition" (
  id                  text PRIMARY KEY,
  epoch_id            text NOT NULL
                        REFERENCES "${q}"."lifecycle_batch_epoch" (id) ON DELETE CASCADE,
  aggregate           text NOT NULL
                        CHECK (aggregate IN ('approved','changes_requested','rejected','partially_approved')),
  terminal            boolean NOT NULL,
  effects_releasable  boolean NOT NULL,
  repair_scope        jsonb NOT NULL DEFAULT '[]'::jsonb,
  union_findings      jsonb NOT NULL DEFAULT '[]'::jsonb,
  per_target_outcomes jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lifecycle_batch_disposition_epoch_uniq UNIQUE (epoch_id)
)`,
    },

    // -----------------------------------------------------------------------
    // The repair LINEAGE (changes_requested request → producer response).
    // -----------------------------------------------------------------------
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."lifecycle_repair" (
  id                                   text PRIMARY KEY,
  -- Stable across the whole reopen CHAIN (base + every successor gate that itself
  -- receives changes_requested) — the cycle guard counts attempts per lineage.
  lineage_id                           text NOT NULL,
  -- The gate that RECEIVED the changes_requested decision (one repair per gate).
  gate_id                              text NOT NULL,
  org_id                               text NOT NULL,
  producer_run_id                      text,
  producer_agent_id                    text,
  base_artifact_id                     text NOT NULL,
  base_representation_revision_id      text NOT NULL,
  -- The reviewer's CAS witness: the base MUST still be this revision at repair.
  expected_base_revision_id            text NOT NULL,
  findings                             jsonb NOT NULL,
  continuation_mode                    text NOT NULL
                                         CHECK (continuation_mode IN ('checkpointed','async_effects_gated')),
  continuation_address                 text,
  -- 1-based ordinal in the lineage (the cycle-guard counter).
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
  -- One repair per gate — a gate receives changes_requested at most once
  -- (recordChangesRequested is idempotent on it).
  CONSTRAINT lifecycle_repair_gate_uniq UNIQUE (gate_id)
)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS lifecycle_repair_lineage_idx
  ON "${q}"."lifecycle_repair" (lineage_id)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS lifecycle_repair_status_idx
  ON "${q}"."lifecycle_repair" (status, created_at)`,
    },

    // -----------------------------------------------------------------------
    // ROUTED ADDITION — the AC-6 rejected-recommendation efficacy row (S3).
    // -----------------------------------------------------------------------
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."run_rejected_recommendations" (
  id                    text PRIMARY KEY,
  run_id                text NOT NULL,
  skill_id              text NOT NULL,
  -- A rejected recommendation may carry no pinned revision (never selected).
  skill_revision_id     text,
  recommendation_source text NOT NULL,
  recommended_rank      integer,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_rejected_recommendations_uniq UNIQUE (run_id, skill_id)
)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS run_rejected_recommendations_run_idx
  ON "${q}"."run_rejected_recommendations" (run_id)`,
    },
  ];
}

// ---------------------------------------------------------------------------
// agent_run_hitl_gates — the DURABLE human-approval gate artifact (cinatra#2748)
// ---------------------------------------------------------------------------
//
// THE DEFECT THIS TABLE CLOSES. A run parked on `pending_approval` carries ONE
// human-answerable artifact: the AG-UI INTERRUPT frame in the Redis Streams run
// event log. That log expires. When the key is gone the artifact is gone from
// every store, `deriveRunHitlContext` derives a formless `{xRenderer:"",
// inputSchema:{}}` shell, and the run renders an unanswerable banner forever.
//
// The remedy is a durable row written at gate MATERIALIZATION time. Redis stays
// the hot path; this row is the fallback the poll surfaces read when the frame
// is gone. It carries exactly what a surface needs to RENDER and ANSWER the
// gate: the renderer id, the schema, the current values, the review-task id, and
// the setup-loop field name when the gate declares one.
//
// IDENTITY = (run_id, review_task_id), the same gate identity
// `artifact_review_gates` uses and the same identity the read-back verification
// in the park seam matches on. It is the PRIMARY KEY, so a re-park of the same
// gate UPSERTS rather than duplicating. `materialized_at` carries the write's
// own clock and is the MONOTONIC guard: the upsert only overwrites when the
// incoming artifact is newer, so a late-landing re-emit of an older artifact can
// never replace a newer one. A run that walks several gates keeps one row per
// gate; the reader takes the newest, which is the gate the run is parked on.
//
// FK to agent_runs ON DELETE CASCADE (the agent_run_hitl_prompts /
// agent_run_test_sends sibling precedent, NOT the FK-less artifact_review_gates
// precedent): this row is meaningless without its run and needs no retention
// machinery of its own — deleting the run reclaims it.
//
// WHY THIS LEAF. The bootstrap DDL for a new table must live in a module
// `drizzle-store.ts` ALREADY imports: drizzle-store is reachable from every
// route, so a NEW leaf would add a first-party module to four route budgets the
// route-graph ratchet locks. This leaf is already in that graph, imports
// nothing, and already hosts the gate-store DDL (and the routed
// `run_rejected_recommendations` addition), so the gate artifact joins it.
//
// FRESH-INSTALL half. The operator-upgrade twin is
// migrations/core/core__0093_agent-run-hitl-gate-artifacts.mjs; both are
// idempotent and are pinned against each other by a DDL-parity suite.
// ---------------------------------------------------------------------------

/** The table name, shared by the schema builder, the store, and the tests. */
export const AGENT_RUN_HITL_GATES_TABLE = "agent_run_hitl_gates";
/** Name of the newest-gate lookup index the fallback reader drives. */
export const AGENT_RUN_HITL_GATES_LATEST_INDEX = "agent_run_hitl_gates_run_id_materialized_at_idx";

export function agentRunHitlGatesSchemaQueries(schemaName: string): QueryInput[] {
  const q = schemaName.replaceAll('"', '""'); // identifier
  return [
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."${AGENT_RUN_HITL_GATES_TABLE}" (
  run_id          text NOT NULL REFERENCES "${q}"."agent_runs"(id) ON DELETE CASCADE,
  review_task_id  text NOT NULL,
  -- What a surface needs to RENDER the gate.
  x_renderer      text NOT NULL,
  input_schema    jsonb NOT NULL,
  gate_values     jsonb NOT NULL,
  -- Setup-loop gates only: the single schema property the form writes back.
  field_name      text,
  -- The write's own clock. The upsert's monotonic guard reads it, so an older
  -- artifact can never overwrite a newer one.
  materialized_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, review_task_id)
)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS ${AGENT_RUN_HITL_GATES_LATEST_INDEX}
  ON "${q}"."${AGENT_RUN_HITL_GATES_TABLE}" (run_id, materialized_at DESC)`,
    },
  ];
}

// ---------------------------------------------------------------------------
// run_recommendation_skips — the RUN-LEVEL skip record (cinatra#2794 S9b)
// ---------------------------------------------------------------------------
//
// THE DEFECT THIS TABLE CLOSES. A skip is a decision about the RUN, and the §V
// card settles only when that decision is on record. The record used to live in
// `run_rejected_recommendations`, which is keyed (run_id, skill_id) — so a skip
// that named no skill (drift retired every offered candidate while the run sat
// parked, or the template read back with no package) had no row to occupy. The
// stop-gap was a RESERVED skill id, `__run_level_skip__`, written into that
// table as if it were a skill.
//
// Why the stop-gap could not stay: skill ids are caller-provided text
// (`createOrUpdateSkill` takes `input.skillId` verbatim, packages/skills/src/
// skills-store.ts) and no constraint excludes the reserved value, so a real
// skill CAN carry that id. Two failures follow from one collision: the efficacy
// reader filtered the id out, silently dropping a genuine rejected skill from
// the accepted/rejected split, and a genuine rejection could be misread as a
// run-level marker. A marker that is only safe while nobody types a particular
// string is not a marker.
//
// SHAPE. One row per run — `run_id` is the PRIMARY KEY, so the write is
// naturally idempotent and a retried skip (a lost response, a double-click)
// converges on the same row instead of duplicating. The row carries:
//   skipped_by      — the principal whose decision this was. The skip path is
//                     already fail-closed on `run.runBy === userId`, so this is
//                     always known at write time and the record names its owner
//                     without a join.
//   candidate_count — how many per-skill efficacy rows accompanied this skip.
//                     This is the fact the sentinel row destroyed: 0 means the
//                     scorer returned nothing to name (drift), n means n
//                     candidates were offered and recorded. The efficacy split
//                     can now tell "skipped with nothing offered" from "skipped
//                     over n offers" WITHOUT inventing a rejected skill.
//   skipped_at      — the decision's own clock.
//
// NO FOREIGN KEY, deliberately, on the sibling precedent: both members of this
// family — `run_selected_skill_revisions` (the accepted half) and
// `run_rejected_recommendations` (the rejected half) — carry a bare `run_id
// text NOT NULL`, and this record is read beside them by the same efficacy
// path. There is also a behavioural reason not to break with them here: a
// failed marker write now REFUSES the skip and leaves the park live, so an FK
// would turn a benign race (the run row deleted concurrently) into a
// user-visible refusal on a decision that is otherwise fine.
//
// WHY THIS LEAF. The bootstrap DDL for a new table must live in a module
// `drizzle-store.ts` ALREADY imports, or a new first-party module joins four
// route budgets the route-graph ratchet locks. This leaf is already in that
// graph and already hosts the sibling `run_rejected_recommendations`, so the
// run-level record joins it (the core__0093 precedent, one file over).
//
// FRESH-INSTALL half. The operator-upgrade twin is
// migrations/core/core__0095_run-recommendation-skip-record.mjs; both are
// idempotent and are pinned against each other by a DDL-parity suite
// (src/lib/__tests__/run-recommendation-skips-schema.test.ts).
// ---------------------------------------------------------------------------

/** The table name, shared by the schema builder, the store, and the tests. */
export const RUN_RECOMMENDATION_SKIPS_TABLE = "run_recommendation_skips";
/** Name of the recency index the skip-audit reads drive. */
export const RUN_RECOMMENDATION_SKIPS_SKIPPED_AT_INDEX =
  "run_recommendation_skips_skipped_at_idx";

export function runRecommendationSkipsSchemaQueries(schemaName: string): QueryInput[] {
  const q = schemaName.replaceAll('"', '""'); // identifier
  return [
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."${RUN_RECOMMENDATION_SKIPS_TABLE}" (
  -- One skip per run: the PK is what makes a retried decision converge instead
  -- of duplicating, and what lets the marker be keyed by the run ALONE.
  run_id          text PRIMARY KEY,
  -- Always known: the skip path is fail-closed on run.runBy === the session.
  skipped_by      text NOT NULL,
  -- How many per-skill efficacy rows rode with this skip. 0 = drift left
  -- nothing to name; the marker still stands.
  candidate_count integer NOT NULL DEFAULT 0,
  skipped_at      timestamptz NOT NULL DEFAULT now()
)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS ${RUN_RECOMMENDATION_SKIPS_SKIPPED_AT_INDEX}
  ON "${q}"."${RUN_RECOMMENDATION_SKIPS_TABLE}" (skipped_at DESC)`,
    },
  ];
}

// ---------------------------------------------------------------------------
// cinatra#2931 (epic #2926 W4) — `artifact_review_audit.renderer_kind` admits
// `first-party`, the provenance of the FORM RUNG: the host's own renderer for a
// declared text form (markdown, escaped plain text). W4 restored that rung to
// the review card, so a markdown draft that used to reach the reviewer as
// "cannot render" now reaches them as the draft — and a target the host rendered
// that way is RECORDED as rendered, never as a floor, because the floor gate
// counts floor rows.
//
// The CREATE TABLE above already carries the widened CHECK, which covers a
// FRESH install. This leaf covers every OTHER database: `CREATE TABLE IF NOT
// EXISTS` leaves an existing table's constraint exactly as core__0072 wrote it,
// and a `renderer_kind` the CHECK refuses does not degrade the audit row — the
// INSERT raises inside the same transaction as the gate CAS, so the whole
// decision rolls back and the draft the reviewer just read in full becomes
// impossible to approve, reject or comment on.
//
// Idempotent DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT (postgres names a column
// CHECK `<table>_<column>_check` deterministically) — a no-op on a schema this
// bootstrap created wide, a widen on a deployed one. Strictly additive: every
// value the old constraint admitted is still admitted. Run AFTER the S0/#1796
// gate tables exist. Migration twin: core__0097.
// ---------------------------------------------------------------------------

export function artifactReviewFormProvenanceSchemaQueries(schemaName: string): QueryInput[] {
  const q = schemaName.replaceAll('"', '""'); // identifier
  return [
    {
      text: `ALTER TABLE "${q}"."artifact_review_audit" DROP CONSTRAINT IF EXISTS artifact_review_audit_renderer_kind_check`,
    },
    {
      text: `ALTER TABLE "${q}"."artifact_review_audit" ADD CONSTRAINT artifact_review_audit_renderer_kind_check
  CHECK (renderer_kind IN ('build-map','runtime','first-party','floor'))`,
    },
  ];
}

// ---------------------------------------------------------------------------
// run_recommendation_offered_set — WHAT THE CARD ACTUALLY OFFERED (cinatra#2906)
// ---------------------------------------------------------------------------
//
// THE DEFECT THIS TABLE CLOSES. A run pauses and offers a short list of skills.
// The reader keeps some of it and presses Confirm. The server did not record
// what was on the card: it asked for the list again, from scratch, and recorded
// against that new answer. A revision published in between re-pinned a confirmed
// skill to a version nobody saw; an assignment withdrawn in between dropped a
// skill the reader plainly kept; and when everything dropped, the run executed
// on the agent's ordinary skill set while the card reported success.
//
// SHAPE. One row per (hold, skill) — the four fields that decide an outcome, and
// none of the ones that only decide how a chip looked. `hold_id` is the park the
// card was drawn against, which is exactly what the row already hands back on
// confirm, so the confirm can read its own offer without trusting the client for
// a value that decides what executes.
//
// THE OFFER IS CLAIMED ONCE. The FIRST draw writes the hold's rows and every
// later draw reads them back; nothing replaces them. The UNIQUE (hold_id,
// skill_id) keeps a re-run of that write idempotent, and the store takes a
// per-hold advisory lock so two concurrent first draws cannot leave a union of
// two partial offers. A replace-on-redraw table would move the offer under a
// reader still looking at the first card, and their confirm would then resolve
// against revisions they were never shown - the very substitution this table
// exists to prevent.
//
// NO FOREIGN KEY, on the family precedent: `run_selected_skill_revisions`,
// `run_rejected_recommendations` and `run_recommendation_skips` all carry a bare
// `run_id text NOT NULL`, and this table is read beside them on the same path.
//
// DEGRADES TO TODAY. A deployment whose bootstrap has not yet created this table
// simply has no snapshot to read, and the confirm keeps its pre-#2906 behaviour
// — so the table's absence costs the fix, never the decision.
//
// WHY THIS LEAF. The bootstrap DDL for a new table must live in a module
// `drizzle-store.ts` ALREADY imports, or a new first-party module joins the
// route budgets the route-graph ratchet locks. This leaf is already in that
// graph and already hosts the rest of this family.
// ---------------------------------------------------------------------------

/** The table name, shared by the schema builder, the store, and the tests. */
export const RUN_RECOMMENDATION_OFFERED_SET_TABLE = "run_recommendation_offered_set";
/** Name of the by-hold index every read of an offer drives. */
export const RUN_RECOMMENDATION_OFFERED_SET_HOLD_INDEX =
  "run_recommendation_offered_set_hold_idx";
/** Name of the by-run index the per-run efficacy reads drive. */
export const RUN_RECOMMENDATION_OFFERED_SET_RUN_INDEX =
  "run_recommendation_offered_set_run_idx";

export function runRecommendationOfferedSetSchemaQueries(schemaName: string): QueryInput[] {
  const q = schemaName.replaceAll('"', '""'); // identifier
  return [
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."${RUN_RECOMMENDATION_OFFERED_SET_TABLE}" (
  id                text PRIMARY KEY,
  run_id            text NOT NULL,
  -- The park the card was drawn against: the offer belongs to a HOLD, not to a
  -- run, because one run can be parked, decided and parked again.
  hold_id           text NOT NULL,
  skill_id          text NOT NULL,
  -- The EXACT revision the chip was drawn at — the pin the confirm honours.
  skill_revision_id text NOT NULL,
  -- Whether the scorer recommended it AT DRAW TIME, which is what the efficacy
  -- split must be measured against.
  recommended       boolean NOT NULL,
  -- Its 1-based rank in the offered ordering at draw time.
  offered_rank      integer NOT NULL,
  offered_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_recommendation_offered_set_uniq UNIQUE (hold_id, skill_id)
)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS ${RUN_RECOMMENDATION_OFFERED_SET_HOLD_INDEX}
  ON "${q}"."${RUN_RECOMMENDATION_OFFERED_SET_TABLE}" (hold_id)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS ${RUN_RECOMMENDATION_OFFERED_SET_RUN_INDEX}
  ON "${q}"."${RUN_RECOMMENDATION_OFFERED_SET_TABLE}" (run_id)`,
    },
  ];
}

// ---------------------------------------------------------------------------
// `artifact_materializations` — the artifact-materialization idempotency ledger
// (cinatra#923) — and `artifact_detection_settings`, the detection ladder's
// per-organisation switch (cinatra#3029, epic #3023 W5).
//
// CO-LOCATED HERE, not in a leaf of their own, for the reason this file already
// states about the lifecycle-interceptions family: this module is ALREADY
// route-reachable, so folding DDL into it adds no route-graph node, while
// `src/lib/drizzle-store.ts` is a baselined file-size-ratchet bottleneck at its
// ceiling and a ceiling may only ever shrink. A slice that must ADD a column to
// the ledger therefore moves the table out rather than growing that file.
//
// TWINS: migrations/core/core__0071 (the `derived_output` path value) and
// migrations/core/core__0100 (the `default_road` path value, the two verdict
// columns, and the settings table). The DDLs MUST stay identical.
// ---------------------------------------------------------------------------
export function materializationLedgerSchemaQueries(
  schemaName: string,
): QueryInput[] {
  const q = schemaName.replaceAll('"', '""');
  return [
    // ---- artifact_materializations idempotency ledger (cinatra#923) ----

    // Claim-then-write-then-finalize journal for declarative artifact
    // materialization (the install-op-journal shape). One row per attempted
    // materialization; the 4-part unique key is the RETRY-idempotency
    // guarantee: a run re-drive (BullMQ retry / duplicate terminal dispatch)
    // hits the same key, reads the finalized row's refs and returns them
    // instead of writing a second artifact. `phase` transitions
    // claimed→finalized INSIDE createSemanticArtifact's Tx2 (atomic with the
    // artifact write — no window in which a committed artifact is invisible
    // to the ledger). An unfinalized (crashed) claim is re-used by the next
    // re-drive.
    //
    // `output_id` identity per path: the EndNode output name for
    // `end_node_binding`; the calling node id for `materialize_tool` (#925);
    // the authoring step id for `llm_emit` provenance rows (unique per emit,
    // so legitimately distinct same-byte emits never collide on the key).
    { text: `CREATE TABLE IF NOT EXISTS "${q}"."artifact_materializations" (
  id                          text PRIMARY KEY,
  org_id                      text NOT NULL,
  run_id                      text NOT NULL,
  output_id                   text NOT NULL,
  node_id                     text,
  path                        text NOT NULL CHECK (path IN ('end_node_binding','materialize_tool','llm_emit','derived_output','default_road')),
  extension                   text NOT NULL,
  content_hash                text NOT NULL,
  artifact_id                 text,
  representation_revision_id  text,
  phase                       text NOT NULL DEFAULT 'claimed' CHECK (phase IN ('claimed','finalized')),
  -- The default road's verdict (cinatra#3029, plan §8.2). NULL on every row the
  -- four declarative paths write — no ladder ran on those.
  decided_rung                text,
  decided_verdict             jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now()
)` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS artifact_materializations_identity_idx ON "${q}"."artifact_materializations" (run_id, output_id, extension, content_hash)` },
    // Advisory cross-path lookup (the WARN-phase LLM-emit dedupe): finalized
    // declarative rows of one run by extension + content hash.
    { text: `CREATE INDEX IF NOT EXISTS artifact_materializations_run_ext_hash_idx ON "${q}"."artifact_materializations" (run_id, extension, content_hash)` },
    { text: `CREATE INDEX IF NOT EXISTS artifact_materializations_org_run_idx ON "${q}"."artifact_materializations" (org_id, run_id)` },
    // ---- artifact_detection_settings (cinatra#3029, epic #3023 W5) ----
    //
    // The detection ladder's model rung is switchable PER ORGANISATION (item
    // 0.18: "a per-organisation switch that turns the rung off and yields plain
    // text"). ABSENT ROW means ON, so a fresh instance and an upgraded one
    // behave identically and nothing has to be backfilled; a row with
    // `model_rung_enabled = false` turns the rung off for that organisation and
    // the ladder yields plain text without reaching a runtime at all. It lives
    // beside the ledger because the ledger row is where its effect is READ: the
    // rung the switch turns off is the one whose verdict that row records.
    { text: `CREATE TABLE IF NOT EXISTS "${q}"."artifact_detection_settings" (
  org_id             text PRIMARY KEY,
  model_rung_enabled boolean NOT NULL DEFAULT true,
  updated_at         timestamptz NOT NULL DEFAULT now()
)` },
    // ---- artifact_revision_review_satisfaction (cinatra#3030, epic #3023 W6)
    //
    // Item 0.30: "the caller's own declared gate is recorded as the review of
    // those revisions, and the produced-output road, when it fires, resolves to
    // that gate instead of opening a second — a satisfaction rule keyed on the
    // artifact revision and the run, new machinery this item names."
    //
    // ONE REVISION NAMES EXACTLY ONE SATISFYING GATE — "one review per artifact,
    // one reference per gate" (section 6 and item 0.9): the key is the
    // organisation, the artifact and the revision, so a second gate cannot be
    // recorded against a revision that already names one. Nothing is
    // backfilled: a revision written before this table names no gate, which
    // reads correctly as "the produced-output road decides on its own".
    { text: `CREATE TABLE IF NOT EXISTS "${q}"."artifact_revision_review_satisfaction" (
  org_id                     text NOT NULL,
  artifact_id                text NOT NULL,
  representation_revision_id text NOT NULL,
  run_id                     text NOT NULL,
  review_task_id             text NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, artifact_id, representation_revision_id)
)` },
    { text: `CREATE INDEX IF NOT EXISTS artifact_revision_review_satisfaction_run_idx ON "${q}"."artifact_revision_review_satisfaction" (org_id, run_id)` },
  ];
}
