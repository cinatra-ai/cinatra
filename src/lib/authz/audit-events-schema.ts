// Bootstrap DDL for `audit_events` — the @cinatra/authz structured
// authorization audit log (the Drizzle table lives beside this file in
// `audit-schema.ts`; the write helpers in `audit.ts`).
//
// A PURE-STRINGS LEAF, extracted from `drizzle-store.ts` (cinatra#2266 slice 2),
// following the precedent this store already set for `auditor-snapshot-schema`,
// `assistant-thread-schema` and `artifacts/artifact-review-gate-schema`: the
// bootstrap DDL for a subsystem lives next to that subsystem, and
// `buildCreateStoreSchemaQueries` spreads it. It moved because the file-size
// ratchet correctly refused to let the store hub grow again, and the honest
// remedy the ratchet asks for is a vertical slice rather than a bigger ceiling.
//
// BYTE-IDENTICAL to what the store emitted before the move, plus the two
// `execution_delivery_key` statements this slice adds. No statement is
// reordered: the legacy-shape upgrade DO-block still runs after the CREATE and
// before the indexes, because it is what makes an operator-UPGRADED database
// (the legacy HITL `review_task_id` / `actor_id` / `event_type` / `payload`
// shape) reach the structured column set the indexes are built on.
//
// No imports, no I/O, no `server-only` — it is consumed by the store's
// pure-strings query builder.

/** One bootstrap statement, matching `buildCreateStoreSchemaQueries`'s shape. */
export type AuditEventsSchemaQuery = { text: string };

/**
 * Every `audit_events` bootstrap statement, in dependency order.
 * `schemaName` is the app schema (`SUPABASE_SCHEMA`, default `cinatra`).
 */
export function auditEventsSchemaQueries(schemaName: string): AuditEventsSchemaQuery[] {
  return [
    // audit_events for @cinatra/authz: structured authorization audit log.
    // Full authorization-audit column set, all fields nullable except id (PK) and created_at.
    // Replaces the legacy HITL audit_events shape; the review_task_id
    // surface was retired. Drop block above (line ~135) handles legacy reset.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."audit_events" (
      id text PRIMARY KEY,
      organization_id text,
      actor_principal_id text,
      actor_principal_type text,
      auth_source text,
      delegated_by text,
      impersonated_user_id text,
      resource_type text,
      resource_id text,
      operation text,
      decision text,
      policy_version text,
      request_id text,
      run_id text,
      a2a_task_id text,
      ip text,
      -- cinatra#2266 G4: the execution plane's PHYSICAL delivery identity
      -- (spoolId:recordId), UNIQUE where present. It is what makes the
      -- kernel insert idempotent, so a record re-delivered after a broker crash
      -- writes one row, not two. NULL for every other producer; NULLs are
      -- distinct in a Postgres unique index, so the constraint touches nothing
      -- that already exists. Existing deployments converge via core__0088.
      execution_delivery_key text,
      metadata jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )` },
    // Forward migration: upgrade legacy audit_events schemas that have the
    // legacy (review_task_id, actor_id, event_type, payload) HITL shape. The new
    // structured columns are ADDED idempotently; legacy columns are kept (NULL on
    // new rows) to avoid data loss for any historical HITL audit entries.
    { text: `DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = '${schemaName.replaceAll("'", "''")}' AND table_name = 'audit_events' AND column_name = 'actor_principal_id'
  ) THEN
    ALTER TABLE "${schemaName.replaceAll('"', '""')}"."audit_events"
      ADD COLUMN IF NOT EXISTS organization_id text,
      ADD COLUMN IF NOT EXISTS actor_principal_id text,
      ADD COLUMN IF NOT EXISTS actor_principal_type text,
      ADD COLUMN IF NOT EXISTS auth_source text,
      ADD COLUMN IF NOT EXISTS delegated_by text,
      ADD COLUMN IF NOT EXISTS impersonated_user_id text,
      ADD COLUMN IF NOT EXISTS resource_type text,
      ADD COLUMN IF NOT EXISTS resource_id text,
      ADD COLUMN IF NOT EXISTS operation text,
      ADD COLUMN IF NOT EXISTS decision text,
      ADD COLUMN IF NOT EXISTS policy_version text,
      ADD COLUMN IF NOT EXISTS request_id text,
      ADD COLUMN IF NOT EXISTS run_id text,
      ADD COLUMN IF NOT EXISTS a2a_task_id text,
      ADD COLUMN IF NOT EXISTS ip text,
      ADD COLUMN IF NOT EXISTS metadata jsonb;
    -- Drop NOT NULL constraints on legacy HITL columns so the structured
    -- INSERT (which supplies none of these) does not fail on upgraded DBs.
    ALTER TABLE "${schemaName.replaceAll('"', '""')}"."audit_events"
      ALTER COLUMN review_task_id DROP NOT NULL,
      ALTER COLUMN actor_id DROP NOT NULL,
      ALTER COLUMN event_type DROP NOT NULL;
  END IF;
END $$` },
    // Drop the legacy review_task_id index if present — replaced by the new indexes below.
    { text: `DROP INDEX IF EXISTS "${schemaName.replaceAll('"', '""')}".audit_events_review_task_id_idx` },
    { text: `CREATE INDEX IF NOT EXISTS audit_events_actor_principal_id_idx ON "${schemaName.replaceAll('"', '""')}"."audit_events" (actor_principal_id)` },
    { text: `CREATE INDEX IF NOT EXISTS audit_events_resource_idx ON "${schemaName.replaceAll('"', '""')}"."audit_events" (resource_type, resource_id)` },
    { text: `CREATE INDEX IF NOT EXISTS audit_events_created_at_idx ON "${schemaName.replaceAll('"', '""')}"."audit_events" (created_at DESC)` },
    // The column is added for schemas that predate it; the UNIQUE index is what
    // the idempotent execution-audit insert conflicts on (cinatra#2266 G4).
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."audit_events" ADD COLUMN IF NOT EXISTS execution_delivery_key text` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS audit_events_execution_delivery_key_key ON "${schemaName.replaceAll('"', '""')}"."audit_events" (execution_delivery_key)` },
  ];
}
