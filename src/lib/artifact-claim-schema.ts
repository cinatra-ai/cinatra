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
// deployment these tables arrive via migration core__0032; on a fresh
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

    // ---- artifact_binding_reconcile_queue: winner-change work queue ----
    // Written in the SAME transaction as the winner transition (one
    // 'binding-reconcile' + one 're-projection' row per change). The consumer
    // lands with the binding write-path sub-issue; until then rows accumulate
    // as durable, idempotently-consumable work.
    { text: `CREATE TABLE IF NOT EXISTS "${q}"."artifact_binding_reconcile_queue" (
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
    )` },
    { text: `CREATE INDEX IF NOT EXISTS artifact_binding_reconcile_queue_pending_idx
      ON "${q}"."artifact_binding_reconcile_queue" (status, created_at)` },
  ];
}
