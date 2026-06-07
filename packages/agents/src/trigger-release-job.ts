import "server-only";
import {
  ensureBackgroundJobRuntime,
} from "@/lib/background-jobs";
import { enqueueAgentRun } from "@/lib/agent-run-enqueue";
import {
  readRunTriggerByRunId,
  createOrUpdateRunTrigger,
} from "./trigger-store";
import { markTriggerReleased } from "./trigger-gate";
import {
  transitionRunStatus,
  RunTransitionError,
  readAgentRunById,
  createAgentRunPendingInput,
} from "./store";

// ---------------------------------------------------------------------------
// runAgentRunTriggerReleaseJob
// ---------------------------------------------------------------------------
// BullMQ worker handler for AGENT_RUN_TRIGGER_RELEASE.
//
// Fired by:
//  - one-shot delayed job (triggerType: "scheduled") when the delay elapses
//  - JobScheduler (triggerType: "recurring") on each cron tick
//
// Behavior:
//   triggerType "scheduled" / "immediate":
//     1. Mark the trigger released (Redis flag + DB releasedAt).
//     2. Transition the run from `armed` → `queued`.
//     3. Enqueue an AGENT_BUILDER_EXECUTION job for the same runId.
//
//   triggerType "recurring":
//     Each cron tick creates a NEW pending run (clone of the schedule-defining
//     run's templateId + inputParams + runBy) and arms it as immediate. The
//     original schedule-defining run stays in its current status. The
//     JobScheduler refires automatically on the next cron tick.
//
//   trigger.enabled === false at fire time:
//     Unschedule (recurring) and skip release. Re-read enabled at fire time;
//     never trust the scheduler-time snapshot.
//
// Idempotent: Redis SET + DB UPDATE are both safe to write twice; the
// armed→queued CAS swallows stale_from_status (twin-fire window).
// ---------------------------------------------------------------------------

export async function runAgentRunTriggerReleaseJob(
  data: { runId: string },
  _jobId: string,
): Promise<void> {
  const trigger = await readRunTriggerByRunId(data.runId);
  if (!trigger) {
    console.warn(
      `[trigger-release] no trigger row for run ${data.runId} — skipping`,
    );
    return;
  }

  // enabled: false → unschedule + skip release.
  if (!trigger.enabled) {
    console.log(
      `[trigger-release] trigger disabled for run ${data.runId} — unscheduling`,
    );
    if (trigger.triggerType === "recurring" && trigger.jobSchedulerId) {
      const runtime = await ensureBackgroundJobRuntime();
      await runtime.queue.removeJobScheduler(trigger.jobSchedulerId);
    }
    return;
  }

  // ---------- Recurring branch ----------
  // Each cron tick creates a fresh pending run + arms it as immediate. The
  // schedule-defining run stays in whatever status it was in (typically still
  // `queued` if it has yet to start, or terminal). Recurring ticks DO NOT
  // re-release the schedule-defining run — gates are monotonic per-run.
  if (trigger.triggerType === "recurring") {
    const sourceRun = await readAgentRunById(data.runId);
    if (!sourceRun) {
      console.warn(
        `[trigger-release] recurring source run ${data.runId} disappeared — skipping tick`,
      );
      return;
    }
    // Defense in depth: TS says sourceRun.orgId is `string` because the column
    // is NOT NULL, so this branch is structurally unreachable in TS-only flows.
    // Kept as a runtime guard so a raw-SQL test fixture, manual DB edit, or
    // otherwise corrupt row that bypasses Drizzle's typing surfaces a clean
    // warn-and-skip rather than poisoning the cron queue with a doomed insert.
    // This matches the existing `if (!sourceRun)` skip-with-warn pattern;
    // throwing would poison the queue.
    if (!sourceRun.orgId) {
      console.warn(
        `[trigger-release] recurring source run ${data.runId} has null org_id — skipping tick`,
      );
      return;
    }
    // Clone: same templateId + inputParams + runBy + orgId.
    // createAgentRunPendingInput mints a new id and returns the row in
    // pending_input status. Propagate orgId so the cloned run preserves tenant
    // scope.
    const newRun = await createAgentRunPendingInput({
      templateId: sourceRun.templateId,
      runBy: sourceRun.runBy,
      orgId: sourceRun.orgId,
      inputParams: sourceRun.inputParams ?? {},
    });
    // Arm the new run as immediate so the gate opens at run-start.
    // We call createOrUpdateRunTrigger directly here (we are inside the worker
    // — no actor context). The setRunTriggerForActor service is for
    // user-initiated changes; recurring ticks are system-initiated.
    await createOrUpdateRunTrigger({
      runId: newRun.id,
      triggerType: "immediate",
      timezone: trigger.timezone,
      enabled: true,
      jobSchedulerId: null,
    });
    await markTriggerReleased(newRun.id);
    try {
      await transitionRunStatus(newRun.id, "pending_input", "queued");
    } catch (err) {
      if (
        !(err instanceof RunTransitionError && err.code === "stale_from_status")
      ) {
        throw err;
      }
    }
    await enqueueAgentRun(
      { runId: newRun.id },
      { jobId: `agent-builder-${newRun.id}` },
    );
    console.log(
      `[trigger-release] recurring tick — created new run ${newRun.id} from ${data.runId}`,
    );
    // The JobScheduler refires automatically on next cron tick.
    return;
  }

  // ---------- Scheduled / immediate branch ----------
  // Open the gate, transition armed → queued, enqueue execution.
  await markTriggerReleased(data.runId);
  console.log(`[trigger-release] released gate for run ${data.runId}`);

  try {
    await transitionRunStatus(data.runId, "armed", "queued");
  } catch (err) {
    if (err instanceof RunTransitionError && err.code === "stale_from_status") {
      // Run was not armed (e.g. immediate trigger fired without going through
      // pending_input → armed; user cancelled to stopped before fire; twin-fire
      // window where the first call already transitioned). Log and skip the
      // execution enqueue — the run is not in a state that wants to run, OR
      // execution was already enqueued by a prior fire.
      console.log(
        `[trigger-release] run ${data.runId} not armed — skipping execution enqueue`,
      );
      return;
    }
    throw err;
  }

  // Enqueue the actual execution job. Idempotent on jobId — re-enqueue is safe
  // if BullMQ has already accepted a job with the same id.
  await enqueueAgentRun(
    { runId: data.runId },
    { jobId: `agent-builder-${data.runId}` },
  );
  console.log(`[trigger-release] enqueued execution for run ${data.runId}`);
}
