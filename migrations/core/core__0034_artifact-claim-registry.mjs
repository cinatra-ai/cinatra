// core__0034 — durable artifact-claim registry (cinatra#1425, epic #1424
// foundation).
//
// Artifact-type CLAIMS become DB state: an installed `kind:"artifact"`
// extension claims typed object rows per scope ('platform' | 'org:<id>'), with
// lifecycle reserved → active → retiring → retired (+ 'dormant' for a default
// claim dominated by a dedicated claim; it reactivates with a NEW generation
// when the dedicated claim retires). Three brand-new tables:
//
//   - artifact_type_claims            the registry. Constraint-backed
//     arbitration: partial UNIQUE (scope, object_type_id) WHERE
//     status='active' (one ACTIVE claim per scope key) and partial UNIQUE
//     (scope, object_type_id) WHERE claim_kind='dedicated' AND
//     status<>'retired' (two DEDICATED claimants on the same type at the same
//     scope are a conflict — an install error) and the mirrored
//     one-live-DEFAULT-claimant index (makes dormancy/reactivation total:
//     at most one default per scope key can ever reactivate into the active
//     slot). `install_id` is plain-text
//     provenance, never an FK: the installed_extension row is deleted on
//     uninstall and claim state must survive it.
//   - artifact_claim_events           append-only claim-event history
//     (reserve/activate/retire/winner-change with actor + version + scope),
//     no FKs, BEFORE UPDATE OR DELETE trigger raises — history survives claim
//     retirement AND installed-row deletion.
//   - artifact_binding_reconcile_queue  durable winner-change work queue
//     (one 'binding-reconcile' + one 're-projection' row per winner change,
//     written in the winner transition's transaction; consumed by the binding
//     write-path sub-issue).
//
// ADDITIVE (brand-new empty tables; migrations/README.md "Additive") — no
// artifact is REQUIRED. Shipped anyway (the core__0027 / core__0030 precedent)
// to keep the fresh-bootstrap and operator-upgrade paths aligned and give the
// tables a ledgered row. The DDL MIRRORS the idempotent bootstrap
// (buildCreateStoreSchemaQueries → artifactClaimSchemaQueries in
// src/lib/artifact-claim-schema.ts) — a no-op on a bootstrap-seeded schema,
// ledger-faked on a fresh install, executed by `db migrate` on an existing
// deployment. No `noTransaction()` (guarded DDL on empty tables is instant).
// Unqualified names ride the runner's search_path (the app schema).

/** Idempotent DDL mirroring the bootstrap — safe to run after it. */
export const artifactClaimRegistryDdlSql = `
  CREATE TABLE IF NOT EXISTS artifact_type_claims (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    scope text NOT NULL,
    object_type_id text NOT NULL,
    claim_kind text NOT NULL,
    extension_package text NOT NULL,
    extension_version text NOT NULL,
    install_id text,
    status text NOT NULL DEFAULT 'reserved',
    generation integer NOT NULL DEFAULT 1,
    dispositions jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT artifact_type_claims_scope_check CHECK (scope = 'platform' OR scope LIKE 'org:_%'),
    CONSTRAINT artifact_type_claims_kind_check CHECK (claim_kind IN ('dedicated','default')),
    CONSTRAINT artifact_type_claims_status_check CHECK (status IN ('reserved','active','dormant','retiring','retired')),
    CONSTRAINT artifact_type_claims_dormant_default_check CHECK (status <> 'dormant' OR claim_kind = 'default')
  );
  CREATE UNIQUE INDEX IF NOT EXISTS artifact_type_claims_one_active_per_scope_type
    ON artifact_type_claims (scope, object_type_id) WHERE status = 'active';
  CREATE UNIQUE INDEX IF NOT EXISTS artifact_type_claims_one_live_dedicated
    ON artifact_type_claims (scope, object_type_id) WHERE claim_kind = 'dedicated' AND status <> 'retired';
  CREATE UNIQUE INDEX IF NOT EXISTS artifact_type_claims_one_live_default
    ON artifact_type_claims (scope, object_type_id) WHERE claim_kind = 'default' AND status <> 'retired';
  CREATE INDEX IF NOT EXISTS artifact_type_claims_type_status_idx
    ON artifact_type_claims (object_type_id, status);
  CREATE INDEX IF NOT EXISTS artifact_type_claims_scope_idx
    ON artifact_type_claims (scope);

  CREATE TABLE IF NOT EXISTS artifact_claim_events (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    seq bigint GENERATED ALWAYS AS IDENTITY,
    claim_id text NOT NULL,
    scope text NOT NULL,
    object_type_id text NOT NULL,
    event text NOT NULL,
    actor text NOT NULL,
    extension_package text NOT NULL,
    extension_version text NOT NULL,
    generation integer NOT NULL,
    payload jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT artifact_claim_events_event_check CHECK (event IN ('reserve','activate','retire','winner-change'))
  );
  CREATE INDEX IF NOT EXISTS artifact_claim_events_claim_idx
    ON artifact_claim_events (claim_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS artifact_claim_events_scope_type_idx
    ON artifact_claim_events (scope, object_type_id, created_at DESC);
  CREATE OR REPLACE FUNCTION fn_artifact_claim_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $body$
  BEGIN
    RAISE EXCEPTION 'artifact_claim_events is append-only: % forbidden — claim history is immutable', TG_OP;
  END;
  $body$;
  DROP TRIGGER IF EXISTS trg_artifact_claim_events_append_only ON artifact_claim_events;
  CREATE TRIGGER trg_artifact_claim_events_append_only BEFORE UPDATE OR DELETE ON artifact_claim_events FOR EACH ROW EXECUTE FUNCTION fn_artifact_claim_events_append_only();

  CREATE TABLE IF NOT EXISTS artifact_binding_reconcile_queue (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    scope text NOT NULL,
    object_type_id text NOT NULL,
    claim_event_id text NOT NULL,
    kind text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    attempts integer NOT NULL DEFAULT 0,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz,
    CONSTRAINT artifact_binding_reconcile_queue_kind_check CHECK (kind IN ('binding-reconcile','re-projection')),
    CONSTRAINT artifact_binding_reconcile_queue_status_check CHECK (status IN ('pending','done','failed'))
  );
  CREATE INDEX IF NOT EXISTS artifact_binding_reconcile_queue_pending_idx
    ON artifact_binding_reconcile_queue (status, created_at);
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(artifactClaimRegistryDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible in shape: the tables are a fresh addition, so dropping them
  // restores the pre-0032 schema exactly. HONEST COST: the claim rows become
  // re-seedable only once the manifest-claims sub-issue's install reconcile
  // lands (nothing re-derives them at THIS slice), and the append-only event
  // log + pending queue rows are audit/work state that is NOT recoverable —
  // an operator-initiated `--down` deliberately accepts losing them (the
  // extension_lifecycle_audit drop precedent).
  pgm.sql(`
    DROP TABLE IF EXISTS artifact_binding_reconcile_queue;
    DROP TRIGGER IF EXISTS trg_artifact_claim_events_append_only ON artifact_claim_events;
    DROP FUNCTION IF EXISTS fn_artifact_claim_events_append_only();
    DROP TABLE IF EXISTS artifact_claim_events;
    DROP TABLE IF EXISTS artifact_type_claims;
  `);
}
