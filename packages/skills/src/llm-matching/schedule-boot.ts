import "server-only";

/**
 * Boot-time registration for the optional `skill-match-batch-default` BullMQ
 * scheduler.
 *
 * Called from `src/lib/background-jobs.ts:ensureBackgroundJobRuntime` on the
 * first boot of each runtime version. Idempotent — BullMQ
 * `upsertJobScheduler` overwrites in place.
 *
 * - When the DB row says `enabled = true` and `cronExpression` is set:
 *   register the scheduler with the cron + timezone from the row.
 * - Otherwise (disabled, missing row, missing cron): make sure no stale
 *   scheduler is left behind — call `removeJobScheduler` and swallow any
 *   not-found errors.
 *
 * The caller in `background-jobs.ts` wraps this in try/catch so a failed
 * DB read at boot does NOT crash the app.
 */

import { ensureBackgroundJobRuntime, BACKGROUND_JOB_NAMES } from "@/lib/background-jobs";
import { SKILL_MATCH_BATCH_SCHEDULER_ID } from "./constants";
import { readSchedule } from "./schedule-store";

export async function registerSkillMatchScheduleAtBoot(): Promise<void> {
  const schedule = await readSchedule();
  const runtime = await ensureBackgroundJobRuntime();

  if (!schedule.enabled || !schedule.cronExpression) {
    // Disabled or no cron — make sure no stale scheduler is left dangling.
    await runtime.queue.removeJobScheduler(SKILL_MATCH_BATCH_SCHEDULER_ID).catch(() => {});
    return;
  }

  await runtime.queue.upsertJobScheduler(
    SKILL_MATCH_BATCH_SCHEDULER_ID,
    { pattern: schedule.cronExpression, tz: schedule.timezone },
    {
      name: BACKGROUND_JOB_NAMES.SKILL_MATCH_BATCH_SUBMIT,
      data: { submittedBy: "scheduler" },
      opts: { attempts: 3, backoff: { type: "exponential", delay: 5_000 } },
    },
  );
}

export async function unregisterSkillMatchSchedule(): Promise<void> {
  const runtime = await ensureBackgroundJobRuntime();
  await runtime.queue.removeJobScheduler(SKILL_MATCH_BATCH_SCHEDULER_ID).catch(() => {});
}
