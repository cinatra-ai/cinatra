// core__0055 — durable publication-operation ledger (cinatra#1450, epic #1448).
//
// One brand-new table: `artifact_publication_operations`. Draftable artifacts
// (social post drafts, ads drafts, email bodies) publish through a durable
// OPERATION record — never directly; queue jobs are DELIVERY, not authority.
// Each row pins the exact representation revision to publish, the destination
// (connector/account/ref), the due time ("publish now" = immediately due), the
// attempt + idempotency key, the cancellation-generation fence, and the
// operation state (pending → running → succeeded | failed | cancelled). The
// artifact's scheduled/published status is a projection written only via the
// ledger's transitions (the #1449 trusted commands).
//
// CONSTRAINTS the DB enforces:
//   - artifact_publication_operations_idempotency_uniq — partial UNIQUE
//     (org_id, idempotency_key) WHERE state <> 'cancelled': at most one
//     live-or-succeeded operation per external-publish identity (the
//     no-double-publish backstop); a cancelled operation frees the slot so an
//     edit-after-unschedule can re-schedule.
//   - state / attempt / cancellation_generation CHECKs (the
//     project_dispatch_attempts precedent).
//
// NO foreign keys ON PURPOSE (the artifact_uninstall_operations / dispatch-
// ledger precedent): durable history outlives artifact deletion and
// representation-table evolution; the pinned revision + artifact ids are
// validated at WRITE time (schedule refuses a non-existent revision), not
// FK-enforced at rest.
//
// ADDITIVE (brand-new empty table + its indexes; migrations/README.md
// "Additive") — no artifact is REQUIRED. Shipped anyway (the core__0037/0047
// precedent) to keep the fresh-bootstrap and operator-upgrade paths aligned and
// give the table a ledgered row. The DDL MIRRORS the idempotent bootstrap
// (buildCreateStoreSchemaQueries → publicationOperationLedgerSchemaQueries, the
// pure-strings leaf src/lib/artifacts/publication-operation-schema.ts, spread in
// the SAME PR) — a no-op on a bootstrap-seeded schema, ledger-faked on a fresh
// install, executed by `db migrate` on an existing deployment. Unqualified names
// ride the runner's search_path (the app schema); metadata-only DDL on an empty
// table, no noTransaction().
//
// SEQ IS PROVISIONAL: shipped max on origin/main at build time is core__0054
// (assistant-template-principal-link); this takes the next free 0055. Migration
// seq is assigned at MERGE — a concurrent lane may land 0055 first, in which
// case a rename-only renumber is normal. migrations/** is HIGH-RISK (owner
// approval); the lane never merges.

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it. */
export const publicationOperationLedgerDdlSql = `
  CREATE TABLE IF NOT EXISTS artifact_publication_operations (
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
  );
  CREATE UNIQUE INDEX IF NOT EXISTS artifact_publication_operations_idempotency_uniq
    ON artifact_publication_operations (org_id, idempotency_key) WHERE state <> 'cancelled';
  CREATE INDEX IF NOT EXISTS artifact_publication_operations_artifact_idx
    ON artifact_publication_operations (org_id, artifact_id, cancellation_generation);
  CREATE INDEX IF NOT EXISTS artifact_publication_operations_type_idx
    ON artifact_publication_operations (org_id, object_type_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS artifact_publication_operations_due_idx
    ON artifact_publication_operations (due_at) WHERE state = 'pending';
  CREATE INDEX IF NOT EXISTS artifact_publication_operations_running_idx
    ON artifact_publication_operations (started_at) WHERE state = 'running';
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(publicationOperationLedgerDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible: the table is a fresh addition, so dropping it restores the exact
  // pre-0055 shape on any lineage (indexes ride the table drop). HONEST COST:
  // any publication-operation history is lost — an operator-initiated `--down`
  // deliberately accepts that (the ledger carries no data on a fresh install and
  // the artifact status it projects is re-derivable from the domain rows).
  pgm.sql(`DROP TABLE IF EXISTS artifact_publication_operations;`);
}
