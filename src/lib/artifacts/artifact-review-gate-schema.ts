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
