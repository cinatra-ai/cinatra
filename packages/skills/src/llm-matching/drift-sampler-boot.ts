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
  SKILL_MATCH_MAINTENANCE_SCHEDULER_ID,
  SKILL_MATCH_MAINTENANCE_CRON_ENV,
} from "./constants";
import { isValidCronExpression } from "./cron-validate";
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

// ---------------------------------------------------------------------------
// Matching-maintenance tick boot (cinatra #1365 / S7). Env-gated
// (SKILL_MATCH_MAINTENANCE_CRON); colocated with the drift-sampler boot above.
// ---------------------------------------------------------------------------

/**
 * Read + validate the maintenance cron from the environment. Pure and exported
 * for unit tests. Returns the trimmed pattern when valid, else null (unset or
 * invalid — both mean "disabled").
 */
export function resolveMaintenanceCron(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = (env[SKILL_MATCH_MAINTENANCE_CRON_ENV] ?? "").trim();
  if (raw.length === 0) return null;
  if (!isValidCronExpression(raw)) {
    console.warn(
      `[background-jobs] ${SKILL_MATCH_MAINTENANCE_CRON_ENV}="${raw}" is not a valid 5- or 6-field cron pattern — maintenance tick disabled.`,
    );
    return null;
  }
  return raw;
}

export async function registerSkillMatchMaintenanceAtBoot(): Promise<void> {
  const pattern = resolveMaintenanceCron();
  const runtime = await ensureBackgroundJobRuntime();

  if (pattern === null) {
    // Disabled (unset/invalid) — remove any scheduler left dangling from a
    // previous boot when it was enabled.
    await runtime.queue.removeJobScheduler(SKILL_MATCH_MAINTENANCE_SCHEDULER_ID).catch(() => {});
    return;
  }

  await runtime.queue.upsertJobScheduler(
    SKILL_MATCH_MAINTENANCE_SCHEDULER_ID,
    { pattern, tz: "UTC" },
    {
      name: BACKGROUND_JOB_NAMES.SKILL_MATCH_MAINTENANCE_TICK,
      data: { invokedBy: "scheduler" },
      // One attempt: a missed tick simply runs next interval. (BullMQ's job
      // scheduler owns the per-iteration jobId, so a fixed jobId cannot be set
      // here — overlap between ticks is practically impossible at a daily/hourly
      // cadence given the bounded per-tick re-eval cap, and BENIGN if it ever
      // happened: the orphan GC's conditional compare-and-delete + grace window
      // are correct regardless. See maintenance.ts.)
      opts: {
        attempts: 1,
        backoff: { type: "exponential", delay: 5_000 },
      },
    },
  );
}

export async function unregisterSkillMatchMaintenance(): Promise<void> {
  const runtime = await ensureBackgroundJobRuntime();
  await runtime.queue.removeJobScheduler(SKILL_MATCH_MAINTENANCE_SCHEDULER_ID).catch(() => {});
}

/**
 * Register every OPT-IN match-store scheduler at boot: the drift sampler
 * (schedule-row-gated) and the matching-maintenance tick (env-gated). Colocated
 * so the host boot orchestrator (src/lib/background-jobs.ts) drives all of them
 * from its single existing drift-sampler boot call site — keeping that
 * size-ratcheted module unchanged. Each registration is independently
 * try/caught so one failure never blocks the others.
 */
// ---------------------------------------------------------------------------
// Agent/skill-match parity observation boot (cinatra #1366 / S8). Env-gated
// (SKILL_MATCH_PARITY_CRON). The scheduler registration is colocated here with
// the sibling match-store boots so the host boot module needs no new call site;
// the parity HANDLER itself is host-side (src/lib/agents-store.ts).
// ---------------------------------------------------------------------------

const AGENT_SKILL_MATCH_PARITY_SCHEDULER_ID = "agent-skill-match-parity-observe" as const;
const SKILL_MATCH_PARITY_CRON_ENV = "SKILL_MATCH_PARITY_CRON" as const;

/** Read + validate the parity cron env (opt-in gate). Exported for unit tests. */
export function resolveParityCron(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = (env[SKILL_MATCH_PARITY_CRON_ENV] ?? "").trim();
  if (raw.length === 0) return null;
  if (!isValidCronExpression(raw)) {
    console.warn(
      `[background-jobs] ${SKILL_MATCH_PARITY_CRON_ENV}="${raw}" is not a valid 5- or 6-field cron pattern — parity observation disabled.`,
    );
    return null;
  }
  return raw;
}

export async function registerAgentSkillMatchParityAtBoot(): Promise<void> {
  const pattern = resolveParityCron();
  const runtime = await ensureBackgroundJobRuntime();
  if (pattern === null) {
    await runtime.queue.removeJobScheduler(AGENT_SKILL_MATCH_PARITY_SCHEDULER_ID).catch(() => {});
    return;
  }
  await runtime.queue.upsertJobScheduler(
    AGENT_SKILL_MATCH_PARITY_SCHEDULER_ID,
    { pattern, tz: "UTC" },
    {
      name: BACKGROUND_JOB_NAMES.SKILL_MATCH_PARITY_OBSERVE,
      data: { invokedBy: "scheduler" },
      opts: { attempts: 1, backoff: { type: "exponential", delay: 5_000 } },
    },
  );
}

export async function unregisterAgentSkillMatchParity(): Promise<void> {
  const runtime = await ensureBackgroundJobRuntime();
  await runtime.queue.removeJobScheduler(AGENT_SKILL_MATCH_PARITY_SCHEDULER_ID).catch(() => {});
}

export async function registerSkillMatchSchedulersAtBoot(): Promise<void> {
  await registerSkillMatchDriftSamplerAtBoot().catch((err) =>
    console.warn("[background-jobs] skill-match drift sampler registration failed:", err),
  );
  await registerSkillMatchMaintenanceAtBoot().catch((err) =>
    console.warn("[background-jobs] skill-match maintenance registration failed:", err),
  );
  await registerAgentSkillMatchParityAtBoot().catch((err) =>
    console.warn("[background-jobs] agent/skill-match parity registration failed:", err),
  );
}
