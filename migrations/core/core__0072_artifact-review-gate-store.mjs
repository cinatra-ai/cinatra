// core__0072 — generic artifact-review GATE store (cinatra#1796, epic #1620 S13).
//
// Four brand-new tables backing the persistence half of the #1795/#1807 generic
// artifact-review surface. #1807 shipped the PURE cores (immutable review-target
// contract, preparation core, and the DECISION core with its one-transaction
// commit contract) but deliberately deferred BOTH the gate-EMISSION side that
// PINS the targets and the LIVE decision-submit binder to THIS slice. These
// tables make pin -> decide -> CAS -> audit -> resume-intent real:
//
//   `artifact_review_gates` — ONE row per (run_id, review_task_id). The emitting
//     gate PINS the frozen `{artifactId, representationRevisionId}` set at gate
//     creation (status 'pending'); a terminal decision CAS-resolves it (status
//     'resolved' + the idempotency `fingerprint` + the `disposition`). UNIQUE
//     (run_id, review_task_id) makes emit idempotent and is the pending-gate
//     anchor the preparation + decision cores read + CAS against.
//   `artifact_review_audit` — one row per reviewed revision per decision, with
//     the HOST-DERIVED renderer provenance (kind/package/digest). UNIQUE
//     (gate_id, decision_fingerprint, artifact_id, representation_revision_id)
//     makes the audit insert idempotent under a response-lost retry.
//   `artifact_review_dispositions` — the durable reject→TOMBSTONE disposition
//     record (kind admits ONLY 'tombstone'; never a hard delete). applied_at NULL
//     ⇒ pending downstream tombstone application on the separate objects store.
//   `artifact_review_resume_outbox` — the terminal RESUME intent, persisted
//     EXACTLY ONCE (PK gate_id ⇒ at most one resume per resolved gate),
//     kind-discriminated ('approve'|'reject') so a reject can never drain down the
//     approve wire; a lease serializes the delivery worker's drain (0071
//     precedent). Delivery is AT-LEAST-ONCE (a send-then-crash redelivers on lease
//     expiry), so the downstream resume consumer must be idempotent per gate.
//
// NO foreign keys to agent_runs ON PURPOSE (the auditor-review-companion /
// publication-operation precedent): the gate is keyed by run id (validated at
// WRITE time by the emitting gate's run-access guard, not FK-pinned) and must
// outlive run-row churn. The three child tables FK to artifact_review_gates(id)
// ON DELETE CASCADE (meaningless without their gate), so this migration is
// self-contained (no cross-migration ordering).
//
// ADDITIVE (four brand-new empty tables + indexes; migrations/README.md
// "Additive") — no artifact is REQUIRED. Shipped anyway (the core__0058/0055
// precedent) so fresh-bootstrap and operator-upgrade paths stay aligned. The DDL
// MIRRORS the idempotent bootstrap leaf
// (buildCreateStoreSchemaQueries → artifactReviewGateSchemaQueries, the
// pure-strings leaf src/lib/artifacts/artifact-review-gate-schema.ts, spread in
// the SAME PR) — a no-op on a bootstrap-seeded schema, ledger-faked on a fresh
// install, executed by `db migrate` on an existing deployment. Unqualified names
// ride the runner's search_path (the app schema); metadata-only DDL on empty
// tables, no noTransaction().
//
// SEQ 0072 — strictly greater than the max shipped seq on origin/main
// (core__0071 unbound-output-derivation-outbox). Migration seq is assigned at
// MERGE: a concurrent lane may land the next seq first, in which case a
// rename-only renumber is normal (this is FLAGGED for the coordinator's train —
// W5's in-rework branch renumbers around this). migrations/** is HIGH-RISK (owner
// approval required); the lane never merges.
//
// DOWN. Reversible in shape: drops the four fresh tables (child tables first,
// then the parent — their indexes ride the drops). HONEST COST: any in-flight
// pending review gate / undelivered resume intent / unapplied disposition rows
// are lost — an operator-initiated `--down` accepts that (the tables carry no
// data on a fresh install and an interrupted review is re-emittable).

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it. */
export const artifactReviewGateDdlSql = `
  CREATE TABLE IF NOT EXISTS artifact_review_gates (
    id              text PRIMARY KEY,
    run_id          text NOT NULL,
    org_id          text NOT NULL,
    review_task_id  text NOT NULL,
    status          text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','resolved')),
    pinned_targets  jsonb NOT NULL,
    -- Only a TERMINAL disposition ever lands on the gate ('comment' is
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
  );
  CREATE UNIQUE INDEX IF NOT EXISTS artifact_review_gates_run_task_uniq
    ON artifact_review_gates (run_id, review_task_id);
  CREATE INDEX IF NOT EXISTS artifact_review_gates_org_idx
    ON artifact_review_gates (org_id);

  CREATE TABLE IF NOT EXISTS artifact_review_audit (
    id                         text PRIMARY KEY,
    gate_id                    text NOT NULL
                                 REFERENCES artifact_review_gates(id) ON DELETE CASCADE,
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
  );
  CREATE UNIQUE INDEX IF NOT EXISTS artifact_review_audit_row_uniq
    ON artifact_review_audit (gate_id, decision_fingerprint, artifact_id, representation_revision_id);
  CREATE INDEX IF NOT EXISTS artifact_review_audit_gate_idx
    ON artifact_review_audit (gate_id);

  CREATE TABLE IF NOT EXISTS artifact_review_dispositions (
    id                         text PRIMARY KEY,
    gate_id                    text NOT NULL
                                 REFERENCES artifact_review_gates(id) ON DELETE CASCADE,
    org_id                     text NOT NULL,
    run_id                     text NOT NULL,
    artifact_id                text NOT NULL,
    representation_revision_id text NOT NULL,
    kind                       text NOT NULL CHECK (kind IN ('tombstone')),
    applied_at                 timestamptz,
    created_at                 timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS artifact_review_dispositions_uniq
    ON artifact_review_dispositions (gate_id, artifact_id, representation_revision_id);
  CREATE INDEX IF NOT EXISTS artifact_review_dispositions_pending_idx
    ON artifact_review_dispositions (created_at) WHERE applied_at IS NULL;

  CREATE TABLE IF NOT EXISTS artifact_review_resume_outbox (
    gate_id          text PRIMARY KEY
                       REFERENCES artifact_review_gates(id) ON DELETE CASCADE,
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
  );
  CREATE INDEX IF NOT EXISTS artifact_review_resume_outbox_status_idx
    ON artifact_review_resume_outbox (status, created_at);
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(artifactReviewGateDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible: all four tables are fresh additions. Drop children first, then
  // the parent (indexes ride the table drops). HONEST COST: any in-flight review
  // gate / resume intent / disposition rows are lost — an operator `--down`
  // accepts that (empty on a fresh install; an interrupted review is re-emittable).
  pgm.sql(`
    DROP TABLE IF EXISTS artifact_review_resume_outbox;
    DROP TABLE IF EXISTS artifact_review_dispositions;
    DROP TABLE IF EXISTS artifact_review_audit;
    DROP TABLE IF EXISTS artifact_review_gates;
  `);
}
