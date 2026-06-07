/**
 * Boot-time drift sampler registration tests.
 *
 * Drives `registerSkillMatchDriftSamplerAtBoot()` with mocked store reads
 * and a captured BullMQ runtime so the test asserts the right
 * `upsertJobScheduler` call (or absence thereof) per row state.
 *
 * Three layers verified:
 *   1. driftSamplerEnabled = false  → upsert NOT called; removeJobScheduler IS called for cleanup
 *   2. driftSamplerEnabled = true with explicit cron → upsert called with that pattern
 *   3. driftSamplerEnabled = true with null cron → upsert called with SKILL_MATCH_DRIFT_DEFAULT_CRON fallback
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const upsertJobSchedulerMock = vi.fn().mockResolvedValue(undefined);
const removeJobSchedulerMock = vi.fn().mockResolvedValue(undefined);
const ensureBackgroundJobRuntimeMock = vi.fn().mockResolvedValue({
  queue: {
    upsertJobScheduler: (...args: unknown[]) => upsertJobSchedulerMock(...args),
    removeJobScheduler: (...args: unknown[]) => removeJobSchedulerMock(...args),
  },
});

vi.mock("@/lib/background-jobs", () => ({
  ensureBackgroundJobRuntime: () => ensureBackgroundJobRuntimeMock(),
  BACKGROUND_JOB_NAMES: {
    SKILL_MATCH_DRIFT_SAMPLE: "skill-match-drift-sample",
  },
}));

const readScheduleMock = vi.fn();
vi.mock("../schedule-store", () => ({
  readSchedule: () => readScheduleMock(),
  writeSchedule: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

import {
  registerSkillMatchDriftSamplerAtBoot,
  unregisterSkillMatchDriftSampler,
} from "../drift-sampler-boot";
import {
  SKILL_MATCH_DRIFT_DEFAULT_CRON,
  SKILL_MATCH_DRIFT_SAMPLER_SCHEDULER_ID,
} from "../constants";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerSkillMatchDriftSamplerAtBoot", () => {
  beforeEach(() => {
    upsertJobSchedulerMock.mockReset();
    removeJobSchedulerMock.mockReset();
    upsertJobSchedulerMock.mockResolvedValue(undefined);
    removeJobSchedulerMock.mockResolvedValue(undefined);
    readScheduleMock.mockReset();
  });

  it("DRIFT-BOOT-01: driftSamplerEnabled=false → upsertJobScheduler NOT called; removeJobScheduler IS called for cleanup", async () => {
    readScheduleMock.mockResolvedValue({
      id: "default",
      enabled: false,
      cronExpression: null,
      timezone: "UTC",
      lastRunAt: null,
      lastRunStatus: null,
      updatedAt: new Date(0),
      driftSamplerEnabled: false,
      driftSamplerCron: null,
    });

    await registerSkillMatchDriftSamplerAtBoot();

    expect(upsertJobSchedulerMock).not.toHaveBeenCalled();
    expect(removeJobSchedulerMock).toHaveBeenCalledTimes(1);
    expect(removeJobSchedulerMock).toHaveBeenCalledWith(SKILL_MATCH_DRIFT_SAMPLER_SCHEDULER_ID);
  });

  it("DRIFT-BOOT-02: driftSamplerEnabled=true with explicit cron → upsertJobScheduler called with that pattern", async () => {
    const customCron = "30 4 * * 1-5";
    readScheduleMock.mockResolvedValue({
      id: "default",
      enabled: false,
      cronExpression: null,
      timezone: "America/New_York",
      lastRunAt: null,
      lastRunStatus: null,
      updatedAt: new Date(0),
      driftSamplerEnabled: true,
      driftSamplerCron: customCron,
    });

    await registerSkillMatchDriftSamplerAtBoot();

    expect(upsertJobSchedulerMock).toHaveBeenCalledTimes(1);
    const [schedulerId, schedule, jobSpec] = upsertJobSchedulerMock.mock.calls[0];
    expect(schedulerId).toBe(SKILL_MATCH_DRIFT_SAMPLER_SCHEDULER_ID);
    expect(schedule).toEqual({ pattern: customCron, tz: "America/New_York" });
    expect(jobSpec.name).toBe("skill-match-drift-sample");
    expect(jobSpec.data).toEqual({ invokedBy: "scheduler" });
    expect(removeJobSchedulerMock).not.toHaveBeenCalled();
  });

  it("DRIFT-BOOT-03: driftSamplerEnabled=true with null cron → upsertJobScheduler called with SKILL_MATCH_DRIFT_DEFAULT_CRON fallback", async () => {
    readScheduleMock.mockResolvedValue({
      id: "default",
      enabled: false,
      cronExpression: null,
      timezone: "UTC",
      lastRunAt: null,
      lastRunStatus: null,
      updatedAt: new Date(0),
      driftSamplerEnabled: true,
      driftSamplerCron: null,
    });

    await registerSkillMatchDriftSamplerAtBoot();

    expect(upsertJobSchedulerMock).toHaveBeenCalledTimes(1);
    const [, schedule] = upsertJobSchedulerMock.mock.calls[0];
    expect(schedule).toEqual({ pattern: SKILL_MATCH_DRIFT_DEFAULT_CRON, tz: "UTC" });
  });

  it("DRIFT-BOOT-04: independent of `enabled` (batch flag off, drift on)", async () => {
    // Verifies the two flags are truly independent — the batch scheduler can
    // be off while the drift sampler is on (or vice versa).
    readScheduleMock.mockResolvedValue({
      id: "default",
      enabled: false,
      cronExpression: null,
      timezone: "UTC",
      lastRunAt: null,
      lastRunStatus: null,
      updatedAt: new Date(0),
      driftSamplerEnabled: true,
      driftSamplerCron: SKILL_MATCH_DRIFT_DEFAULT_CRON,
    });

    await registerSkillMatchDriftSamplerAtBoot();

    expect(upsertJobSchedulerMock).toHaveBeenCalledTimes(1);
    expect(removeJobSchedulerMock).not.toHaveBeenCalled();
  });

  it("DRIFT-BOOT-05: idempotent — calling twice with the same enabled config still issues one upsert per call (BullMQ handles dedup)", async () => {
    readScheduleMock.mockResolvedValue({
      id: "default",
      enabled: false,
      cronExpression: null,
      timezone: "UTC",
      lastRunAt: null,
      lastRunStatus: null,
      updatedAt: new Date(0),
      driftSamplerEnabled: true,
      driftSamplerCron: null,
    });

    await registerSkillMatchDriftSamplerAtBoot();
    await registerSkillMatchDriftSamplerAtBoot();

    // BullMQ's upsertJobScheduler is idempotent — the boot hook fires the
    // call each time; the once-per-runtime guard lives in the caller
    // (background-jobs.ts:ensureBackgroundJobRuntime).
    expect(upsertJobSchedulerMock).toHaveBeenCalledTimes(2);
  });
});

describe("unregisterSkillMatchDriftSampler", () => {
  beforeEach(() => {
    upsertJobSchedulerMock.mockReset();
    removeJobSchedulerMock.mockReset();
    upsertJobSchedulerMock.mockResolvedValue(undefined);
    removeJobSchedulerMock.mockResolvedValue(undefined);
  });

  it("DRIFT-BOOT-06: removes the scheduler ID; never throws on missing scheduler", async () => {
    await unregisterSkillMatchDriftSampler();
    expect(removeJobSchedulerMock).toHaveBeenCalledTimes(1);
    expect(removeJobSchedulerMock).toHaveBeenCalledWith(SKILL_MATCH_DRIFT_SAMPLER_SCHEDULER_ID);
  });

  it("DRIFT-BOOT-07: swallows removeJobScheduler rejection (e.g., scheduler never existed)", async () => {
    removeJobSchedulerMock.mockRejectedValueOnce(new Error("not found"));
    await expect(unregisterSkillMatchDriftSampler()).resolves.toBeUndefined();
  });
});
