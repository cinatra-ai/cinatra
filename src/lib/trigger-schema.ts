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
      last_fired_at timestamptz,
      stopped_at timestamptz,
      job_scheduler_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS agent_run_triggers_released_at_idx ON "${s}"."agent_run_triggers" (released_at)` },
    // last_fired_at — the stamp a RECURRING tick writes when it actually fires
    // (cinatra#2972). A recurring schedule never releases its own run's gate —
    // each tick starts a COPY — so `released_at` stays null on the row for the
    // life of the schedule and cannot answer "has this fired once". The plan
    // asks exactly that question: PLAN (A) §7.2 as amended 2026-08-25, "its one
    // control is **Cancel schedule**, shown only for a recurring schedule that
    // has fired once". This column is that answer, written by the fire path and
    // read by nothing else.
    //
    // ADDITIVE AND SEPARATE from `released_at`: widening that stamp to cover a
    // recurring tick would open the schedule-defining run's OWN side-effect
    // gate, which is the one thing a tick must never do.
    { text: `ALTER TABLE "${s}"."agent_run_triggers" ADD COLUMN IF NOT EXISTS last_fired_at timestamptz` },
    // stopped_at — the stamp **Cancel schedule** writes (cinatra#2972). Plan (A)
    // §7.2 as amended 2026-08-25: it "stops the recurring schedule and then
    // makes the scheduler non-editable".
    //
    // IT IS NOT `enabled`, and that distinction is load-bearing. `enabled` is
    // already writable by the `trigger_config_set` MCP tool for any trigger of
    // any type, so reading a false `enabled` as "the person pressed Cancel
    // schedule" would reinterpret every row anything else ever disabled — and
    // then refuse to let it be re-armed. A dedicated stamp means exactly one
    // act writes it. `enabled` is still ALSO set false by the stop, because the
    // fire path already refuses a disabled trigger at fire time; the two are
    // belt and braces, not one signal read two ways.
    { text: `ALTER TABLE "${s}"."agent_run_triggers" ADD COLUMN IF NOT EXISTS stopped_at timestamptz` },
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
