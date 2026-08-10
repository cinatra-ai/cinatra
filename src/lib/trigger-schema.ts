// Bootstrap DDL for the TRIGGER LIFECYCLE tables — a pure string builder with
// ZERO imports (a synchronous leaf, safe for `drizzle-store.ts`'s synchronous
// composition).
//
// It lives here rather than inline because drizzle-store.ts is a baselined
// file-size-ratchet bottleneck sitting exactly at its ceiling — the same reason
// and the same pattern as `assistant-thread-schema.ts` and
// `extension-grant-schema.ts`. The trigger family is extracted WHOLE rather than
// only the new tables, so the lifecycle's DDL has one home instead of two.
//
// The tables, and why each exists:
//
//   agent_run_triggers  — the per-run trigger gate (immediate/scheduled/recurring).
//   agent_run_pm_links  — the schedule↔PM-task mirror (cinatra#317). A LINK table,
//     not columns on the trigger, so a PM outage leaves the trigger untouched.
//
//   trigger_schedule_proposal_consumes (cinatra#2569, epic #2564 S5) — the
//     SINGLE-USE edge for a conversational schedule proposal. The proposal token
//     is stateless and replayable by construction; SPENDING it is not.
//     `consume_key` is the PRIMARY KEY, so a second Confirm carrying the same
//     proposal loses the insert and its whole transaction — including the run it
//     was about to create — rolls back.
//
//   trigger_schedule_install_outbox (cinatra#2569) — the install INTENT. A
//     trigger has two halves in two systems (the durable row and the BullMQ
//     scheduler), so Confirm commits an intent and a drain installs it in a
//     PINNED ORDER: ARM the run, THEN expose the schedule. Exposing first lets a
//     release fire on a not-armed run, where the `armed → queued` CAS logs and
//     skips and a one-shot fire is lost. The full argument lives in
//     `packages/agents/src/trigger-schedule-proposal-store.ts`.
//
// The two #2569 tables are NET-NEW, so they are ADDITIVE under
// migrations/README.md ("a new table" needs no numbered artifact): the
// fresh-install shape is born here and the idempotent bootstrap carries it onto
// existing deployments at the next boot. Both cascade from `agent_runs(id)` and
// are keyed one row per run, so deleting a run collects them and neither grows
// independently of the run population. The Drizzle twins live in
// `packages/agents/src/schema.ts`.

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
    // trigger_schedule_proposal_consumes: the SINGLE-USE consume edge for a
    // conversational schedule proposal (cinatra#2569, epic #2564 S5). The
    // proposal token is stateless and replayable by construction; spending it is
    // not. consume_key is the PK, so a second Confirm carrying the same proposal
    // loses the insert and its whole transaction — including the run it was about
    // to create — rolls back; the loser then reads this row and answers with the
    // ORIGINAL run_id. run_id is NOT NULL because it is written in the SAME
    // transaction as the run it names.
    { text: `CREATE TABLE IF NOT EXISTS "${s}"."trigger_schedule_proposal_consumes" (
      consume_key text PRIMARY KEY,
      run_id text NOT NULL REFERENCES "${s}"."agent_runs"(id) ON DELETE CASCADE,
      org_id text NOT NULL,
      template_id text NOT NULL,
      consumed_by text NOT NULL,
      consumed_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS trigger_schedule_proposal_consumes_run_idx ON "${s}"."trigger_schedule_proposal_consumes" (run_id)` },
    // trigger_schedule_install_outbox: the schedule-INSTALL intent (cinatra#2569).
    // A trigger has two halves in two systems — the durable row and the BullMQ
    // scheduler — so Confirm commits an INTENT and a drain installs in a PINNED
    // ORDER: ARM the run, THEN expose the schedule. Exposing first would let a
    // release fire on a not-armed run, where the armed→queued CAS logs and skips
    // and a one-shot fire is lost. run_id is the PK: one install per run.
    { text: `CREATE TABLE IF NOT EXISTS "${s}"."trigger_schedule_install_outbox" (
      run_id text PRIMARY KEY REFERENCES "${s}"."agent_runs"(id) ON DELETE CASCADE,
      org_id text NOT NULL,
      requested_by text NOT NULL,
      trigger_type text NOT NULL,
      scheduled_at timestamptz,
      cron_expression text,
      timezone text NOT NULL DEFAULT 'UTC',
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','installing','done','failed')),
      attempts integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 20,
      lease_token text,
      lease_expires_at timestamptz,
      last_error text,
      armed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS trigger_schedule_install_outbox_status_idx ON "${s}"."trigger_schedule_install_outbox" (status, created_at)` },
  ];
}
