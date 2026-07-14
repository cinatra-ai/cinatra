// Bootstrap DDL for the durable artifact-claim registry (cinatra#1425, epic
// #1424 foundation) — the tables that make artifact-type CLAIMS DB state:
//
//   - artifact_type_claims           the claim registry: scope × object type,
//                                    lifecycle reserved → active → retiring →
//                                    retired (+ dormant for default claims
//                                    dominated by a dedicated claim), version-
//                                    bound to the claiming extension version.
//   - artifact_claim_events          append-only claim-event log (reserve /
//                                    activate / retire / winner-change with
//                                    actor + version + scope). Carries NO
//                                    foreign key on purpose: history must
//                                    survive claim retirement AND deletion of
//                                    the installed_extension row (the installed
//                                    row is deleted on uninstall today).
//   - artifact_binding_reconcile_queue  durable work queue written atomically
//                                    with every winner change: one
//                                    'binding-reconcile' and one
//                                    're-projection' row per change, consumed
//                                    by the binding write-path sub-issue.
//
// CONSTRAINT MODEL (the arbitration the DB itself enforces):
//   - artifact_type_claims_one_active_per_scope_type — partial UNIQUE
//     (scope, object_type_id) WHERE status = 'active': at most ONE active
//     claim per scope key.
//   - artifact_type_claims_one_live_dedicated — partial UNIQUE
//     (scope, object_type_id) WHERE claim_kind = 'dedicated' AND
//     status <> 'retired': two DEDICATED claimants on the same type at the
//     same scope are a CONFLICT (constraint-backed install error), while
//     dedicated-vs-default coexistence stays legal (the default goes dormant).
//   - artifact_type_claims_one_live_default — the SAME one-live-claimant rule
//     for DEFAULT claims: at most one live default claimant per scope key.
//     This is what makes dormancy/reactivation total: reactivation can never
//     race two dormant defaults into one active slot (the transition SQL
//     updates at most one row per scope key), and a retiring/active overlap
//     of same-rank claims is structurally impossible.
//
// Kind-over-scope PRECEDENCE (dedicated-org > dedicated-platform >
// default-org > default-platform) is cross-scope and therefore resolved in
// the pure policy leaf (`@cinatra-ai/objects` claims module) + the claim
// store, not by a single-table constraint.
//
// A pure string builder with ZERO imports — a synchronous leaf, safe for
// drizzle-store.ts's synchronous require() composition (same contract as
// skill-lifecycle-schema.ts / co-owner-constraint-schema.ts). On an EXISTING
// deployment these tables arrive via migration core__0034; on a fresh
// bootstrap they ship directly here — the two paths converge (idempotent DDL).
// The enum value sets below are a schema contract mirrored by the
// @cinatra-ai/objects `claims` policy leaf; artifact-claim-schema.test.ts
// asserts they stay in sync.

export function artifactClaimSchemaQueries(schemaName: string): { text: string }[] {
  const q = schemaName.replaceAll('"', '""'); // identifier
  return [
    // ---- artifact_type_claims: the durable claim registry ----
    // `install_id` is PLAIN TEXT provenance (never an FK): the claim row must
    // survive the deletion of the installed_extension row on uninstall — the
    // uninstall path retires the claim instead. `generation` increments each
    // time a claim (re)becomes the winner for its scope key; bindings carry it
    // and go stale when it moves (epic #1424 transition safety).
    { text: `CREATE TABLE IF NOT EXISTS "${q}"."artifact_type_claims" (
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
    )` },
    // At most one ACTIVE claim per (scope, type) — the issue's
    // "partial-unique on ACTIVE per scope key".
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS artifact_type_claims_one_active_per_scope_type
      ON "${q}"."artifact_type_claims" (scope, object_type_id) WHERE status = 'active'` },
    // Two DEDICATED claimants on the same type at the same scope conflict
    // while either is live (anything but 'retired') — the AC-1 constraint.
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS artifact_type_claims_one_live_dedicated
      ON "${q}"."artifact_type_claims" (scope, object_type_id) WHERE claim_kind = 'dedicated' AND status <> 'retired'` },
    // ... and at most one live DEFAULT claimant per scope key (see header).
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS artifact_type_claims_one_live_default
      ON "${q}"."artifact_type_claims" (scope, object_type_id) WHERE claim_kind = 'default' AND status <> 'retired'` },
    { text: `CREATE INDEX IF NOT EXISTS artifact_type_claims_type_status_idx
      ON "${q}"."artifact_type_claims" (object_type_id, status)` },
    { text: `CREATE INDEX IF NOT EXISTS artifact_type_claims_scope_idx
      ON "${q}"."artifact_type_claims" (scope)` },

    // ---- artifact_claim_events: append-only claim-event history ----
    // `claim_id` carries NO foreign key ON PURPOSE (the skill_revisions /
    // extension_lifecycle_audit precedent): events are durable history that
    // survives claim retirement and installed_extension deletion, and an FK
    // cascade would fire the append-only trigger below and abort the parent
    // delete. Every column an auditor needs is DENORMALIZED onto the event.
    // `seq` is the AUTHORITATIVE event order (a monotonic identity): `now()`
    // is transaction-stable and ids are random UUIDs, so timestamp+id reads
    // would interleave same-transaction events arbitrarily. Writers order
    // multi-event statements explicitly (single INSERT ... SELECT ... ORDER
    // BY an ordinal), so seq reflects true transition order.
    { text: `CREATE TABLE IF NOT EXISTS "${q}"."artifact_claim_events" (
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
    )` },
    { text: `CREATE INDEX IF NOT EXISTS artifact_claim_events_claim_idx
      ON "${q}"."artifact_claim_events" (claim_id, created_at DESC)` },
    { text: `CREATE INDEX IF NOT EXISTS artifact_claim_events_scope_type_idx
      ON "${q}"."artifact_claim_events" (scope, object_type_id, created_at DESC)` },
    // DB-level immutability: any UPDATE or DELETE of an event row raises.
    // Mirrors fn_skill_revisions_append_only / fn_representation_append_only.
    { text: `CREATE OR REPLACE FUNCTION "${q}"."fn_artifact_claim_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  RAISE EXCEPTION 'artifact_claim_events is append-only: % forbidden — claim history is immutable', TG_OP;
END;
$body$` },
    { text: `DROP TRIGGER IF EXISTS trg_artifact_claim_events_append_only ON "${q}"."artifact_claim_events"` },
    { text: `CREATE TRIGGER trg_artifact_claim_events_append_only BEFORE UPDATE OR DELETE ON "${q}"."artifact_claim_events" FOR EACH ROW EXECUTE FUNCTION "${q}"."fn_artifact_claim_events_append_only"()` },

    // ---- artifact_binding_reconcile_queue: reconcile work queue ----
    // Two axes of durable, idempotently-consumable work:
    //   - CLAIM-side (kind 'binding-reconcile' | 're-projection'): one row per
    //     winner change, written in the SAME transaction as the winner
    //     transition, keyed by (scope, object_type_id, claim_event_id).
    //   - OBJECT-side (kind 'binding-reconcile-write', cinatra#1493): one
    //     per-artifact row written in the SAME transaction as the object write
    //     (upsertObjectAndEnqueue) whenever a create / type-change could affect
    //     the row's binding. It carries the concrete (org_id, object_id) so the
    //     consumer reconciles exactly that artifact — the durable record that
    //     makes the write-path reconcile crash-safe (a type-change AWAY from a
    //     claimed type leaves a stale binding no later TYPE sweep can select, so
    //     the object-side axis cannot be a type sweep). claim_event_id is NULL
    //     for a write-driven row (there is no claim event); the shape CHECK
    //     keeps each kind's required columns honest.
    { text: `CREATE TABLE IF NOT EXISTS "${q}"."artifact_binding_reconcile_queue" (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      scope text NOT NULL,
      object_type_id text NOT NULL,
      claim_event_id text,
      object_id text,
      org_id text,
      kind text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      attempts integer NOT NULL DEFAULT 0,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      processed_at timestamptz,
      CONSTRAINT artifact_binding_reconcile_queue_kind_check CHECK (kind IN ('binding-reconcile','re-projection','binding-reconcile-write')),
      CONSTRAINT artifact_binding_reconcile_queue_status_check CHECK (status IN ('pending','done','failed')),
      CONSTRAINT artifact_binding_reconcile_queue_shape_check CHECK (
        CASE WHEN kind = 'binding-reconcile-write'
             THEN object_id IS NOT NULL AND org_id IS NOT NULL
             ELSE claim_event_id IS NOT NULL END)
    )` },
    { text: `CREATE INDEX IF NOT EXISTS artifact_binding_reconcile_queue_pending_idx
      ON "${q}"."artifact_binding_reconcile_queue" (status, created_at)` },
    // Self-heal (cinatra#1493): an operator DB whose queue table was created by
    // the core__0034 bootstrap converges here on boot — a fresh CREATE above
    // already carries these; migration core__0043 is the node-pg-migrate
    // operator path. Every statement is a no-op on a bootstrap-seeded schema.
    { text: `ALTER TABLE "${q}"."artifact_binding_reconcile_queue" ADD COLUMN IF NOT EXISTS object_id text` },
    { text: `ALTER TABLE "${q}"."artifact_binding_reconcile_queue" ADD COLUMN IF NOT EXISTS org_id text` },
    { text: `ALTER TABLE "${q}"."artifact_binding_reconcile_queue" ALTER COLUMN claim_event_id DROP NOT NULL` },
    { text: `DO $reconcile_queue_kind$ BEGIN
      ALTER TABLE "${q}"."artifact_binding_reconcile_queue" DROP CONSTRAINT IF EXISTS artifact_binding_reconcile_queue_kind_check;
      ALTER TABLE "${q}"."artifact_binding_reconcile_queue" ADD CONSTRAINT artifact_binding_reconcile_queue_kind_check CHECK (kind IN ('binding-reconcile','re-projection','binding-reconcile-write'));
      ALTER TABLE "${q}"."artifact_binding_reconcile_queue" DROP CONSTRAINT IF EXISTS artifact_binding_reconcile_queue_shape_check;
      ALTER TABLE "${q}"."artifact_binding_reconcile_queue" ADD CONSTRAINT artifact_binding_reconcile_queue_shape_check CHECK (
        CASE WHEN kind = 'binding-reconcile-write'
             THEN object_id IS NOT NULL AND org_id IS NOT NULL
             ELSE claim_event_id IS NOT NULL END);
    END $reconcile_queue_kind$` },
    // cinatra#1432: the uninstall-operation lineage tables ride THIS claim-system
    // schema leaf so the drizzle-store bootstrap wires the whole claim system
    // through the single existing spread call — holding the drizzle-store
    // file-size ratchet (the #1426 extract-to-hold-the-ratchet pattern). They
    // are the claim system's uninstall archival + replay lineage; kept a
    // separately-exported function below for direct SQL-shape tests.
    ...artifactUninstallOperationSchemaQueries(schemaName),
    // cinatra#1429: the binding write-path support (quarantine + backfill
    // checkpoint tables) + the asserted_by='system' CHECK widening ride the
    // SAME claim-system spread (same ratchet-holding rationale). Spread LAST so
    // the asserted_by reconcile runs after semantic_assertion exists (created by
    // semanticAssertionSchemaQueries, spread earlier in buildCreateStoreSchemaQueries);
    // existing deployments via migration core__0040.
    ...bindingWritePathSchemaQueries(schemaName),
  ];
}

const SYSTEM_CHECK_LIST = "'user','authoring_skill','agent','matcher','system'";

// ---------------------------------------------------------------------------
// Binding write-path support (cinatra#1429, epic #1424) — the tables the
// binding reconcile + per-claim activation gate need, plus the asserted_by
// CHECK widening. Inlined here (zero-import) to ride the single claim-system
// spread and hold the drizzle-store file-size ratchet.
//
//   - object_binding_quarantine  — per-object exclusion set the activation gate
//     populates when an enrolling type's legacy row fails registered-Zod
//     validation; the reconcile + backfill sweep SKIP quarantined rows. Keyed
//     (org_id, object_id); append-idempotent (ON CONFLICT DO NOTHING).
//   - artifact_binding_backfill_checkpoint — resumable backfill watermark (one
//     row per scope × object_type_id × generation; cursor_object_id is the
//     batch watermark), UNIQUE (scope, object_type_id, generation).
//   - sa_assertedby_chk += 'system' — bindings are asserted_by='system' (the
//     service principal driving reconciliation). Guarded reconcile: only
//     re-validates when the constraint is absent or lacks 'system'; existing
//     rows never carry 'system', so widening never rejects.
//
// On an existing deployment these arrive via migration core__0040; on a fresh
// bootstrap they ship here — the two paths converge (idempotent DDL). Kept a
// separately-exported function for direct SQL-shape tests.
// ---------------------------------------------------------------------------
export function bindingWritePathSchemaQueries(schemaName: string): { text: string }[] {
  const q = schemaName.replaceAll('"', '""'); // identifier
  const l = schemaName.replaceAll("'", "''"); // string literal
  return [
    { text: `CREATE TABLE IF NOT EXISTS "${q}"."object_binding_quarantine" (
      org_id text NOT NULL,
      object_id text NOT NULL,
      object_type_id text NOT NULL,
      quarantined_generation integer,
      reason text NOT NULL,
      detail jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT object_binding_quarantine_pk PRIMARY KEY (org_id, object_id)
    )` },
    { text: `CREATE INDEX IF NOT EXISTS object_binding_quarantine_type_idx
      ON "${q}"."object_binding_quarantine" (object_type_id)` },
    { text: `CREATE TABLE IF NOT EXISTS "${q}"."artifact_binding_backfill_checkpoint" (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      scope text NOT NULL,
      object_type_id text NOT NULL,
      generation integer NOT NULL,
      cursor_object_id text,
      processed_count integer NOT NULL DEFAULT 0,
      inserted_count integer NOT NULL DEFAULT 0,
      quarantined_skipped integer NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'running',
      started_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      CONSTRAINT abbc_status_chk CHECK (status IN ('running','done')),
      CONSTRAINT abbc_scope_chk CHECK (scope = 'platform' OR scope LIKE 'org:_%')
    )` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS abbc_one_per_key
      ON "${q}"."artifact_binding_backfill_checkpoint" (scope, object_type_id, generation)` },
    // asserted_by CHECK widening — guarded so repeated bootstraps do not re-scan.
    { text: `DO $abchk$
DECLARE def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE c.conname = 'sa_assertedby_chk'
     AND t.relname = 'semantic_assertion'
     AND n.nspname = '${l}';
  IF def IS NULL THEN
    ALTER TABLE "${q}"."semantic_assertion"
      ADD CONSTRAINT sa_assertedby_chk CHECK (asserted_by IN (${SYSTEM_CHECK_LIST}));
  ELSIF position('system' IN def) = 0 THEN
    ALTER TABLE "${q}"."semantic_assertion" DROP CONSTRAINT sa_assertedby_chk;
    ALTER TABLE "${q}"."semantic_assertion"
      ADD CONSTRAINT sa_assertedby_chk CHECK (asserted_by IN (${SYSTEM_CHECK_LIST}));
  END IF;
END $abchk$` },
  ];
}

// ---------------------------------------------------------------------------
// Artifact-extension UNINSTALL-OPERATION lineage (cinatra#1432, epic #1424).
//
//   - artifact_uninstall_operations            one row per uninstall archival
//     run (scope 'platform' | 'org:<id>' × claiming extension), status
//     running → completed (or failed), jsonb checkpoint so an interrupted
//     archival resumes; replayed_at/replayed_install_id set ONCE by the
//     reinstall replay (an operation replays at most once).
//   - artifact_uninstall_operation_assertions  append-only lineage of EXACTLY
//     the semantic_assertion rows an operation archived, denormalized with
//     everything replay needs (org/artifact/extension/asserted_by/principal +
//     assertion_basis so replay restores only the CLASSIC subset — BINDING
//     lineage regenerates from current claims, never replayed as classic);
//     UNIQUE (operation_id, assertion_id) makes checkpoint-resumed archival
//     idempotent; a BEFORE UPDATE OR DELETE trigger raises (immutable history).
//
// No FKs on purpose (the artifact_claim_events precedent above): operation +
// lineage survive installed_extension deletion and assertion-table evolution.
// On an existing deployment these tables arrive via migration core__0037; on a
// fresh bootstrap they ship here — the two paths converge (idempotent DDL).
// ---------------------------------------------------------------------------
export function artifactUninstallOperationSchemaQueries(schemaName: string): { text: string }[] {
  const q = schemaName.replaceAll('"', '""'); // identifier
  return [
    // `scope` matches the claim registry's scope vocabulary
    // ('platform' | 'org:<id>'). `checkpoint` carries the resumable cursor
    // ({"orgId","artifactId"} of the last fully-archived artifact).
    { text: `CREATE TABLE IF NOT EXISTS "${q}"."artifact_uninstall_operations" (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      scope text NOT NULL,
      extension_package text NOT NULL,
      extension_version text NOT NULL,
      actor text NOT NULL,
      status text NOT NULL DEFAULT 'running',
      archived_count integer NOT NULL DEFAULT 0,
      checkpoint jsonb,
      replayed_at timestamptz,
      replayed_install_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      CONSTRAINT artifact_uninstall_operations_scope_check CHECK (scope = 'platform' OR scope LIKE 'org:_%'),
      CONSTRAINT artifact_uninstall_operations_status_check CHECK (status IN ('running','completed','failed'))
    )` },
    { text: `CREATE INDEX IF NOT EXISTS artifact_uninstall_operations_pkg_scope_idx
      ON "${q}"."artifact_uninstall_operations" (extension_package, scope, created_at DESC)` },

    // Append-only lineage: one row per assertion the operation ARCHIVED,
    // written in the SAME transaction as the archive UPDATE (a data-modifying
    // CTE selects from the archived rows), so it is exactly-the-archived-set by
    // construction. `assertion_basis` lets replay restore only the CLASSIC
    // subset (binding lineage regenerates from current claims). UNIQUE
    // (operation_id, assertion_id) makes checkpoint-resumed archival idempotent.
    { text: `CREATE TABLE IF NOT EXISTS "${q}"."artifact_uninstall_operation_assertions" (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      operation_id text NOT NULL,
      assertion_id text NOT NULL,
      org_id text NOT NULL,
      artifact_id text NOT NULL,
      extension text NOT NULL,
      asserted_by text NOT NULL,
      asserted_by_principal text,
      assertion_basis text NOT NULL DEFAULT 'classic',
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT artifact_uninstall_operation_assertions_basis_check CHECK (assertion_basis IN ('binding','classic')),
      CONSTRAINT artifact_uninstall_operation_assertions_op_assertion_uq UNIQUE (operation_id, assertion_id)
    )` },
    { text: `CREATE INDEX IF NOT EXISTS artifact_uninstall_operation_assertions_op_idx
      ON "${q}"."artifact_uninstall_operation_assertions" (operation_id, org_id, artifact_id)` },
    // DB-level immutability: lineage rows are history (what replay is owed); any
    // UPDATE or DELETE raises. Mirrors fn_artifact_claim_events_append_only.
    { text: `CREATE OR REPLACE FUNCTION "${q}"."fn_artifact_uninstall_op_assertions_append_only"() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  RAISE EXCEPTION 'artifact_uninstall_operation_assertions is append-only: % forbidden — uninstall lineage is immutable', TG_OP;
END;
$body$` },
    { text: `DROP TRIGGER IF EXISTS trg_artifact_uninstall_op_assertions_append_only ON "${q}"."artifact_uninstall_operation_assertions"` },
    { text: `CREATE TRIGGER trg_artifact_uninstall_op_assertions_append_only BEFORE UPDATE OR DELETE ON "${q}"."artifact_uninstall_operation_assertions" FOR EACH ROW EXECUTE FUNCTION "${q}"."fn_artifact_uninstall_op_assertions_append_only"()` },
  ];
}
