import "server-only";
import {
  ensureBackgroundJobRuntime,
} from "@/lib/background-jobs";
import { enqueueAgentRun } from "@/lib/agent-run-enqueue";
import { readRunTriggerPmState } from "@/lib/pm-integration-providers";
import {
  readRunTriggerByRunId,
  createOrUpdateRunTrigger,
  deleteRunTriggerByRunId,
  type TriggerRecord,
} from "./trigger-store";
import { deletePmLinkByRunId } from "./pm-link-store";
import { scheduleTrigger, cancelTriggerSchedule } from "./trigger-schedule";
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
  // The LOCAL `!enabled` short-circuit stays the immediate skip and runs BEFORE
  // the PM check: a locally-disabled trigger is authoritative without consulting
  // PM (and a 'paused' PM result must NOT collide with this — see below).
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

  // ---------- Pre-execution PM check (cinatra#319) ----------
  // BEFORE firing, consult PM-side state so a PM-side delete / reschedule / pause
  // is honored at fire time. FAIL-OPEN: the bridge NEVER throws and classifies
  // every outage as no-provider / no-link / unreachable; those proceed to fire.
  // Only definitive PM signals (deleted / paused / rescheduled) alter the fire.
  // ALL local side-effects below are wrapped so a failure logs + falls through
  // to FIRE — a PM glitch must never strand the run.
  const pmAction = await checkPmStateBeforeFire(trigger, data.runId);
  if (pmAction === "skip") {
    // The PM handler already performed its teardown/refresh and decided this
    // fire should not happen (deleted / paused / rescheduled). Stop here.
    return;
  }
  // pmAction === "fire" → fall through to the normal release logic below.

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

// ---------------------------------------------------------------------------
// checkPmStateBeforeFire — the cinatra#319 pre-execution PM consult
// ---------------------------------------------------------------------------
// Reads PM-side state (via the host bridge, which NEVER throws and classifies
// every outage as a fail-open kind) and applies the PM-authoritative decision:
//
//   no-provider | no-link | unreachable | present → "fire" (proceed; warn on
//       unreachable). The PM side has nothing decisive to say, or agrees → fire.
//
//   deleted     → tear the schedule down + delete the local trigger row + the
//       pm-link row + transition the run armed→stopped, then "skip" — the
//       upstream task is gone. RECURRING removes the JobScheduler (distinct from
//       the active tick). A scheduled ONE-SHOT is NOT cancelled here: it is THIS
//       active, locked job and self-completes on "skip" (removing an active job
//       would throw → spurious FIRE).
//
//   paused      → "skip" THIS fire only. Leave the schedule in place and DO NOT
//       mutate local `enabled` (persisting enabled=false would collide with the
//       pre-PM `!enabled` short-circuit + the recurring scheduler removal — keep
//       it purely PM-authoritative per tick).
//
//   rescheduled → "skip" this tick — never fire the OLD tick after learning of a
//       change (refresh-then-skip). RECURRING re-arms via scheduleTrigger/
//       upsertJobScheduler with the PM cron + persists it. A scheduled ONE-SHOT
//       in the FUTURE is NOT re-armed inline (the in-flight deterministic-id job
//       is active + retained, so re-add would no-op/diverge); instead it PERSISTS
//       the new instant + clears releasedAt + skips, and the reconcile loop
//       (#318) re-arms the delayed job. now/past → fire.
//
// FAIL-OPEN SIDE-EFFECTS: every local mutation here is wrapped — on ANY failure
// we log and return "fire" so a transient local error never strands the run; the
// reconcile loop (#318) repairs the residual state.
// ---------------------------------------------------------------------------
async function checkPmStateBeforeFire(
  trigger: TriggerRecord,
  runId: string,
): Promise<"fire" | "skip"> {
  const pm = await readRunTriggerPmState({
    runId,
    triggerType: trigger.triggerType,
    localCronExpression: trigger.cronExpression,
    localScheduledAt: trigger.scheduledAt
      ? trigger.scheduledAt.toISOString()
      : null,
  });

  switch (pm.kind) {
    case "no-provider":
    case "no-link":
    case "present":
      // Nothing PM-decisive — fire normally.
      return "fire";

    case "unreachable":
      // PM outage / misconfigured provider → fail-open proceed (warn).
      console.warn(
        `[trigger-release] PM pre-exec read unreachable for run ${runId} (firing anyway): ${pm.reason}`,
      );
      return "fire";

    case "deleted": {
      console.log(
        `[trigger-release] PM task for run ${runId} was DELETED upstream — tearing down local schedule + skipping`,
      );
      try {
        // Tear down the FUTURE schedule. For recurring this removes the
        // JobScheduler (distinct from this active tick — safe). For a scheduled
        // ONE-SHOT we must NOT cancel here: the delayed job has ALREADY fired
        // (it is THIS active, locked job) — `getJob(id).remove()` on an active
        // job throws, which the catch below would turn into a spurious FIRE,
        // defeating the delete (codex#319). The one-shot self-completes when we
        // return "skip"; only the local rows need cleanup.
        if (trigger.triggerType === "recurring") {
          await cancelTriggerSchedule({
            jobSchedulerId: trigger.jobSchedulerId,
            triggerType: "recurring",
          });
        }
        await deleteRunTriggerByRunId(runId);
        await deletePmLinkByRunId(runId);
        // Mirror the local-delete path (deleteRunTriggerForActor): a deleted
        // schedule must not leave the run stuck in `armed` with no trigger row
        // or job to ever release it (codex#319). Transition armed → stopped;
        // swallow stale_from_status (the run was never armed / already moved on,
        // e.g. a recurring schedule-defining run that is queued/terminal).
        try {
          await transitionRunStatus(runId, "armed", "stopped");
        } catch (err) {
          if (
            !(err instanceof RunTransitionError && err.code === "stale_from_status")
          ) {
            throw err;
          }
          console.log(
            `[trigger-release] run ${runId} not armed on PM-delete — leaving status as-is`,
          );
        }
      } catch (err) {
        // A local teardown glitch must not strand the run — fall through to FIRE.
        console.warn(
          "[trigger-release] PM-delete teardown failed for run",
          runId,
          "— firing anyway:",
          err,
        );
        return "fire";
      }
      return "skip";
    }

    case "paused": {
      // Skip THIS fire only. Do NOT mutate local enabled or remove the schedule
      // — the next tick re-checks PM (PM-authoritative per tick). No local writes.
      console.log(
        `[trigger-release] PM task for run ${runId} is PAUSED — skipping this fire (schedule left intact)`,
      );
      return "skip";
    }

    case "rescheduled": {
      try {
        if (trigger.triggerType === "recurring") {
          // Refresh the recurring schedule to the PM cron, persist it, skip this
          // tick. A rescheduled recurring with no PM cron is incoherent — treat
          // a null cron as "nothing to refresh" and fire normally.
          if (!pm.cronExpression) {
            console.warn(
              `[trigger-release] PM reschedule for recurring run ${runId} had no cron — firing this tick`,
            );
            return "fire";
          }
          const result = await scheduleTrigger({
            runId,
            triggerType: "recurring",
            cronExpression: pm.cronExpression,
            timezone: trigger.timezone,
          });
          await createOrUpdateRunTrigger({
            runId,
            triggerType: "recurring",
            cronExpression: pm.cronExpression,
            timezone: trigger.timezone,
            enabled: true,
            jobSchedulerId: result.jobSchedulerId,
          });
          console.log(
            `[trigger-release] PM rescheduled recurring run ${runId} to cron "${pm.cronExpression}" — refreshed + skipping this tick`,
          );
          return "skip";
        }

        // Scheduled one-shot: if the new instant is in the FUTURE, persist it +
        // skip (reconcile #318 re-arms — see below); if now/past, fire this tick.
        const newAtMs = pm.scheduledAt ? Date.parse(pm.scheduledAt) : NaN;
        if (!pm.scheduledAt || Number.isNaN(newAtMs)) {
          console.warn(
            `[trigger-release] PM reschedule for scheduled run ${runId} had no valid instant — firing this tick`,
          );
          return "fire";
        }
        // A 1s floor mirrors scheduleTrigger's past-time guard — an instant
        // effectively "now" should fire, not be re-armed into an immediate error.
        const newDelay = newAtMs - Date.now();
        if (newDelay < 1000) {
          console.log(
            `[trigger-release] PM rescheduled scheduled run ${runId} to a now/past instant — firing this tick`,
          );
          return "fire";
        }
        // Scheduled ONE-SHOT moved to a FUTURE instant. We deliberately do NOT
        // re-arm a BullMQ job inline here (codex#319): the in-flight job IS the
        // deterministic-id one-shot (`trigger-release-{runId}`), it is ACTIVE and
        // self-completes on this "skip", and BullMQ retains it (removeOnComplete:
        // 200). Re-adding the SAME id now no-ops (HSETNX) and silently drops the
        // reschedule; using a DIFFERENT id would diverge from the deterministic
        // id the local reschedule path (setRunTriggerForActor → scheduleTrigger)
        // reuses, leaving a retained completed job that later collides. Either
        // inline re-arm is unsafe from within the firing job. So we PERSIST the
        // new instant (and clear releasedAt) and SKIP — the run stays armed with
        // the corrected time, and the reconcile loop (#318) re-arms the delayed
        // job once this one-shot has completed and its id is free. This honors
        // the reschedule (never fires the OLD tick) without any id hazard.
        await createOrUpdateRunTrigger({
          runId,
          triggerType: "scheduled",
          scheduledAt: new Date(newAtMs),
          timezone: trigger.timezone,
          enabled: true,
          // Keep the prior jobSchedulerId untouched; the in-flight one-shot is
          // completing and #318 owns the deterministic re-arm. Clear releasedAt
          // so the re-armed instant can open the gate.
          jobSchedulerId: trigger.jobSchedulerId,
          releasedAt: null,
        });
        console.log(
          `[trigger-release] PM rescheduled scheduled run ${runId} to ${pm.scheduledAt} — persisted new instant + skipping this tick (reconcile #318 re-arms the delayed job)`,
        );
        return "skip";
      } catch (err) {
        // A refresh glitch must not strand the run — fall through to FIRE.
        console.warn(
          "[trigger-release] PM reschedule refresh failed for run",
          runId,
          "— firing anyway:",
          err,
        );
        return "fire";
      }
    }

    default: {
      // Exhaustiveness guard: an unknown kind fails open (fire).
      const _exhaustive: never = pm;
      void _exhaustive;
      return "fire";
    }
  }
}
