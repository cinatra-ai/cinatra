// Bootstrap DDL for the TRIGGER LIFECYCLE tables — a pure string builder with
// ZERO imports (a synchronous leaf, safe for `drizzle-store.ts`'s synchronous
// composition). Spread into buildCreateStoreSchemaQueries, so every statement
// here is executed core-store DDL and in scope for the schema-migration gate.
//
// It lives here rather than inline because drizzle-store.ts is a baselined
// file-size-ratchet bottleneck sitting exactly at its ceiling — the same reason
// and the same pattern as `assistant-thread-schema.ts`.
//
// RELOCATED, not rewritten (cinatra#2569). Both tables are DEPLOYED, so this
// leaf is a pure move: the CREATE text below is byte-identical to what
// `buildCreateStoreSchemaQueries` executed inline, with only the schema
// interpolation rebound to the local `s` alias. The Core-store schema-migration
// gate reads composed DDL — a spread-reached leaf is an in-scope schema region
// — so the move classifies as the no-data-impact relocation it is (cinatra#2648
// taught the classifier exactly this shape). Nothing here may be edited in the
// same commit as a move: a relocation and a definition change must be separable
// by eye, and the gate's provenance trace exists to keep them so.

export function triggerSchemaQueries(schemaName: string): { text: string }[] {
  const s = schemaName.replaceAll('"', '""');
  return [
    // agent_run_triggers: per-run trigger gate (immediate/scheduled/recurring)
    { text: `CREATE TABLE IF NOT EXISTS "${s}"."agent_run_triggers" (
      run_id text PRIMARY KEY REFERENCES "${s}"."agent_runs"(id) ON DELETE CASCADE,
      trigger_type text NOT NULL DEFAULT 'immediate',
      scheduled_at timestamptz,
      cron_expression text,
      timezone text NOT NULL DEFAULT 'UTC',
      enabled boolean NOT NULL DEFAULT true,
      released_at timestamptz,
      job_scheduler_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS agent_run_triggers_released_at_idx ON "${s}"."agent_run_triggers" (released_at)` },
    // agent_run_pm_links: schedule↔PM-task sync link table (cinatra#317). One
    // row per schedule-defining trigger mirrored to an external PM provider
    // (Plane). Keyed by run_id (one-to-one with the trigger). A link table, not
    // columns on agent_run_triggers, so a PM outage / absent provider leaves the
    // trigger untouched. external_task_id/synced_at are null until the first
    // successful push; sync_error holds the last fail-open error (null=healthy);
    // version is the optimistic-concurrency counter for the reconcile loop.
    { text: `CREATE TABLE IF NOT EXISTS "${s}"."agent_run_pm_links" (
      run_id text PRIMARY KEY REFERENCES "${s}"."agent_runs"(id) ON DELETE CASCADE,
      provider text NOT NULL,
      external_task_id text,
      synced_at timestamptz,
      sync_error text,
      version integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS agent_run_pm_links_provider_idx ON "${s}"."agent_run_pm_links" (provider)` },
  ];
}
