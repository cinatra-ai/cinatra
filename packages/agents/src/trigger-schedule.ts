import "server-only";
import {
  BACKGROUND_JOB_NAMES,
  enqueueBackgroundJob,
  ensureBackgroundJobRuntime,
} from "@/lib/background-jobs";
import { markTriggerReleased } from "./trigger-gate";

// ---------------------------------------------------------------------------
// trigger-schedule
// ---------------------------------------------------------------------------
// Configures the BullMQ side of the trigger gate:
//   - immediate  → mark released immediately; no queued job
//   - scheduled  → one-shot delayed job (enqueueBackgroundJob with delay)
//   - recurring  → JobScheduler with cron pattern + IANA tz
//                   (NEVER the deprecated `Queue.add(..., { repeat })` option)
//
// BullMQ 5.x's `Queue.add(..., { repeat })` is deprecated and slated for
// removal in v6, so we use `upsertJobScheduler` exclusively. The release-job
// ID convention `trigger-release-{runId}` is shared between the one-shot
// delayed job (jobId) and the recurring scheduler (schedulerId) so cancel paths
// can use a single id.
// ---------------------------------------------------------------------------

export type ScheduleTriggerArgs = {
  runId: string;
  triggerType: "immediate" | "scheduled" | "recurring";
  scheduledAt?: Date;
  cronExpression?: string;
  timezone: string;
};

export type ScheduleResult = { jobSchedulerId: string | null };

function jobSchedulerIdFor(runId: string): string {
  return `trigger-release-${runId}`;
}

/**
 * Configure the BullMQ side of the trigger.
 *
 * - immediate  → mark released; return { jobSchedulerId: null }
 * - scheduled  → one-shot delayed job (delay = scheduledAt - now); throws if
 *                scheduledAt is in the past
 * - recurring  → upsertJobScheduler with the supplied cron + IANA tz;
 *                attempts:3, exponential backoff delay 5s on the job opts
 *                to survive transient Redis errors
 */
export async function scheduleTrigger(
  args: ScheduleTriggerArgs,
): Promise<ScheduleResult> {
  if (args.triggerType === "immediate") {
    await markTriggerReleased(args.runId);
    return { jobSchedulerId: null };
  }

  if (args.triggerType === "scheduled") {
    if (!args.scheduledAt) {
      throw new Error("scheduledAt is required for scheduled triggers");
    }
    // Clamp to zero to avoid negative delay from clock drift between the
    // service-layer validation and here. Use a 1-second floor: a scheduledAt
    // that is effectively "now" (delay < 1000 ms) should have been rejected by
    // the service layer's `<= Date.now()` guard; if it slipped through, treat
    // it as a past-time error to avoid ambiguous "fire immediately" semantics.
    const rawDelay = args.scheduledAt.getTime() - Date.now();
    if (rawDelay < 1000) {
      throw new Error("scheduled time is in the past or too close to now");
    }
    const delay = rawDelay;
    const id = jobSchedulerIdFor(args.runId);
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.AGENT_RUN_TRIGGER_RELEASE,
      { runId: args.runId },
      { jobId: id, delay },
    );
    return { jobSchedulerId: id };
  }

  if (args.triggerType === "recurring") {
    if (!args.cronExpression) {
      throw new Error("cronExpression is required for recurring triggers");
    }
    const runtime = await ensureBackgroundJobRuntime();
    const id = jobSchedulerIdFor(args.runId);
    await runtime.queue.upsertJobScheduler(
      id,
      { pattern: args.cronExpression, tz: args.timezone },
      {
        name: BACKGROUND_JOB_NAMES.AGENT_RUN_TRIGGER_RELEASE,
        data: { runId: args.runId },
        opts: {
          attempts: 3,
          backoff: { type: "exponential", delay: 5_000 },
        },
      },
    );
    return { jobSchedulerId: id };
  }

  throw new Error(`invalid trigger configuration: ${JSON.stringify(args)}`);
}

export type CancelTriggerArgs = {
  jobSchedulerId: string | null;
  triggerType: "immediate" | "scheduled" | "recurring";
};

/**
 * Cancel a scheduled BullMQ trigger.
 *
 * - immediate  → no-op (immediate triggers never enqueue a job)
 * - recurring  → removeJobScheduler(id)
 * - scheduled  → getJob(id).remove() (one-shot delayed job)
 */
export async function cancelTriggerSchedule(
  args: CancelTriggerArgs,
): Promise<void> {
  if (!args.jobSchedulerId) return;
  const runtime = await ensureBackgroundJobRuntime();
  if (args.triggerType === "recurring") {
    await runtime.queue.removeJobScheduler(args.jobSchedulerId);
    return;
  }
  if (args.triggerType === "scheduled") {
    const job = await runtime.queue.getJob(args.jobSchedulerId);
    if (job) {
      await job.remove();
    }
  }
}
