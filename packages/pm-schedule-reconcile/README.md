# @cinatra-ai/pm-schedule-reconcile

A small reconcile worker for the schedule↔PM-task sync foundation (cinatra#317/#366).
It re-drives the **OUTBOUND** mirror of cinatra agent-run schedules to a PM provider
(Plane today) for the link rows that need repair — rows whose last push errored,
that never synced, or whose mirror is stale.

The worker is dependency-injected and **outbound-repair only**: the LOCAL trigger is the
source of truth and PM is a best-effort projection. It does NOT apply inbound PM state to
local schedules — the SDK `PmConnector` contract has only `upsertTriggerTask` +
`deleteTriggerTask` (no read-back), and Plane stores only a day-granularity `target_date`,
so a precise local cron cannot round-trip back. Every path warns-and-skips per row and
never throws, so a PM outage cannot poison the BullMQ queue or alter local schedules.

## What it does, per link row

1. Re-read the **local trigger** (source of truth).
2. If the trigger **exists** → re-push it outward via the host bridge (`syncTrigger`).
   This covers "existence" (re-create a dropped upstream task) and "paused/enabled"
   (re-project the enabled flag), using only the idempotent outbound contract.
3. If the trigger is **gone** but the link holds an `external_task_id` → finish the
   **deferred delete** via the host bridge (`deleteTrigger`).
4. If the trigger is **gone**, there is no `external_task_id`, and there is **no**
   `sync_error` (provably-clean, never pushed) → route through `deleteTrigger`; the host
   bridge drops the dead link row.
5. If the trigger is **gone** and the link is **unknown-upstream** (no `external_task_id`
   but a `sync_error`) → leave the row **sticky** and warn. The outbound-only contract
   cannot prove no upstream task exists; dropping the row could orphan a live task. A
   true prove-no-task capability is a separate high-risk SDK follow-up.

The sweep pages through the **entire** candidate set in bounded `pageSize` chunks (keyset
on `run_id`) — there is no per-sweep row cap, so later rows are never starved by sticky or
still-failing early rows.

## Public API

- `runPmScheduleReconcile` — run one outbound-repair pass, return a summary
- `PmScheduleReconcileDeps` — injected enumerator, local-trigger reader, and the two
  host-bridge functions (`syncTrigger`, `deleteTrigger`)
- `PmScheduleReconcileOptions` — `pageSize` (keyset page size; the sweep pages to completion)
- `PmScheduleReconcileSummary` — per-run counts: attempted, repaired, skipped, failed
- `PmLinkReconcileRow`, `LocalTriggerSnapshot` — narrowed row shapes

Sub-entry point:

- `@cinatra-ai/pm-schedule-reconcile/worker` — the worker implementation module

## Usage

```ts
import { runPmScheduleReconcile } from "@cinatra-ai/pm-schedule-reconcile";

const summary = await runPmScheduleReconcile({
  listLinksNeedingReconcile: ({ afterRunId, limit }) => loadLinkPage(afterRunId, limit),
  readLocalTrigger: (runId) => readTrigger(runId),
  syncTrigger: (input) => syncRunTriggerPmTask(input),
  deleteTrigger: ({ runId }) => deleteRunTriggerPmTask({ runId }),
});

console.log(summary); // { attempted, repaired, skipped, failed, ... }
```

## Docs

See https://docs.cinatra.ai for full documentation.
