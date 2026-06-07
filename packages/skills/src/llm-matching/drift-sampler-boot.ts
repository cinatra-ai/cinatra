import "server-only";

/**
 * Boot-time registration of the optional `skill-match-drift-sampler` BullMQ
 * scheduler.
 *
 * Mirrors the structure of `registerSkillMatchScheduleAtBoot()` (the batch
 * scheduler registration) but checks the `drift_sampler_enabled` flag on the
 * `skill_match_schedule` singleton row instead of the existing `enabled`
 * flag. The two flags are independent — an operator can run the drift
 * sampler with the batch scheduler turned off, and vice versa.
 *
 * Disabled by default. Boot-time DB read failure must not crash the app. When
 * `drift_sampler_enabled = false`, this hook is a no-op except for cleaning
 * up any stale scheduler entry left behind from a previous boot when the flag
 * was on.
 *
 * --- Why a separate scheduler ID --------------------------------------------
 *
 * Using a distinct scheduler ID (`skill-match-drift-sampler`) keeps the
 * sampler completely isolated from the existing batch scheduler — toggling
 * the batch scheduler off does not also toggle the sampler off.
 * BullMQ's `upsertJobScheduler` is keyed by ID; idempotent across boots.
 *
 * --- When to call -----------------------------------------------------------
 *
 * Called from `src/lib/background-jobs.ts:ensureBackgroundJobRuntime()`
 * after `registerSkillMatchScheduleAtBoot()`. The caller wraps both calls
 * in try/catch so a failed DB read at boot does NOT crash the app.
 */

import { ensureBackgroundJobRuntime, BACKGROUND_JOB_NAMES } from "@/lib/background-jobs";
import {
  SKILL_MATCH_DRIFT_SAMPLER_SCHEDULER_ID,
  SKILL_MATCH_DRIFT_DEFAULT_CRON,
} from "./constants";
import { readSchedule } from "./schedule-store";

export async function registerSkillMatchDriftSamplerAtBoot(): Promise<void> {
  const schedule = await readSchedule();
  const runtime = await ensureBackgroundJobRuntime();

  if (!schedule.driftSamplerEnabled) {
    // Disabled — make sure no stale scheduler is left dangling from a
    // previous boot when it was on. Mirrors the batch-scheduler cleanup.
    await runtime.queue.removeJobScheduler(SKILL_MATCH_DRIFT_SAMPLER_SCHEDULER_ID).catch(() => {});
    return;
  }

  // When the operator has enabled the sampler but did not specify an explicit
  // cron, fall back to the default `0 3 * * *` (03:00 UTC daily). This keeps
  // "enable with no further config" a one-flag toggle.
  const pattern = schedule.driftSamplerCron ?? SKILL_MATCH_DRIFT_DEFAULT_CRON;

  await runtime.queue.upsertJobScheduler(
    SKILL_MATCH_DRIFT_SAMPLER_SCHEDULER_ID,
    { pattern, tz: schedule.timezone },
    {
      name: BACKGROUND_JOB_NAMES.SKILL_MATCH_DRIFT_SAMPLE,
      data: { invokedBy: "scheduler" },
      // The sampler is a low-stakes drift canary; one retry on transient
      // failure is plenty. Differs from the batch scheduler's 3-attempt
      // policy because a missed sample just means we read the next day's
      // sample instead — there's no operator-visible failure mode here.
      opts: { attempts: 1, backoff: { type: "exponential", delay: 5_000 } },
    },
  );
}

export async function unregisterSkillMatchDriftSampler(): Promise<void> {
  const runtime = await ensureBackgroundJobRuntime();
  await runtime.queue.removeJobScheduler(SKILL_MATCH_DRIFT_SAMPLER_SCHEDULER_ID).catch(() => {});
}
