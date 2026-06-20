/**
 * Regression coverage for recurring trigger ticks cloning `sourceRun.orgId` into
 * the new run created by `createAgentRunPendingInput`.
 *
 * When `runAgentRunTriggerReleaseJob({ runId })` reads
 * `sourceRun = { ..., orgId: "org-source" }`, the subsequent
 * `createAgentRunPendingInput` call MUST receive `orgId: "org-source"`.
 *
 * NO BACKWARD COMPATIBILITY. When `sourceRun.orgId` is null/undefined the
 * recurring tick MUST refuse to clone. There is no fallback NULL write, because
 * a recurring run must stay attached to its source organization.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const TEST_ORG_ID = "org-source";

// vi.hoisted spies for every dep that runAgentRunTriggerReleaseJob touches.
const trigger = vi.hoisted(() => ({
  readRunTriggerByRunId: vi.fn(),
  createOrUpdateRunTrigger: vi.fn(async () => undefined),
  deleteRunTriggerByRunId: vi.fn(async () => undefined),
}));
const gate = vi.hoisted(() => ({
  markTriggerReleased: vi.fn(async () => undefined),
}));
const store = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  createAgentRunPendingInput: vi.fn(),
  transitionRunStatus: vi.fn(async () => undefined),
  RunTransitionError: class RunTransitionError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));
const bg = vi.hoisted(() => ({
  enqueueBackgroundJob: vi.fn(async () => undefined),
  ensureBackgroundJobRuntime: vi.fn(async () => ({
    queue: { removeJobScheduler: vi.fn(async () => undefined) },
  })),
  BACKGROUND_JOB_NAMES: {
    AGENT_BUILDER_EXECUTION: "agent-builder-execution",
    AGENT_RUN_TRIGGER_RELEASE: "agent-run-trigger-release",
  },
}));
// cinatra#319 deps the release job now touches: the host PM bridge (pre-exec
// read), the pm-link teardown, the schedule (cancel/refresh) and the enqueue.
// The discriminated PM pre-exec result the bridge returns; typed loosely here so
// each test can resolve any kind (incl. the carried fields on rescheduled/
// unreachable) without fighting the inferred narrow `{ kind: "no-provider" }`.
type PmPreExecResult = { kind: string; [k: string]: unknown };
const pmBridge = vi.hoisted(() => ({
  // Default: nothing PM-decisive → fire normally (no provider/link).
  readRunTriggerPmState: vi.fn<() => Promise<PmPreExecResult>>(async () => ({
    kind: "no-provider",
  })),
}));
const pmLink = vi.hoisted(() => ({
  deletePmLinkByRunId: vi.fn(async () => undefined),
}));
const schedule = vi.hoisted(() => ({
  scheduleTrigger: vi.fn(async () => ({ jobSchedulerId: "sched_new" })),
  cancelTriggerSchedule: vi.fn(async () => undefined),
}));
const enqueue = vi.hoisted(() => ({
  enqueueAgentRun: vi.fn(async () => undefined),
}));

vi.mock("../trigger-store", () => trigger);
vi.mock("../trigger-gate", () => gate);
vi.mock("../store", () => store);
vi.mock("../pm-link-store", () => pmLink);
vi.mock("../trigger-schedule", () => schedule);
vi.mock("@/lib/background-jobs", () => bg);
vi.mock("@/lib/pm-integration-providers", () => pmBridge);
vi.mock("@/lib/agent-run-enqueue", () => enqueue);

beforeEach(() => {
  vi.clearAllMocks();
  // Re-establish the fail-open default after clearAllMocks resets impls.
  pmBridge.readRunTriggerPmState.mockResolvedValue({ kind: "no-provider" });
  schedule.scheduleTrigger.mockResolvedValue({ jobSchedulerId: "sched_new" });
});

function makeRecurringTrigger() {
  return {
    runId: "run-source",
    triggerType: "recurring" as const,
    enabled: true,
    timezone: "UTC",
    jobSchedulerId: "sched_1",
  };
}

function makeSourceRun(overrides: Partial<{ orgId: string | null }> = {}) {
  return {
    id: "run-source",
    templateId: "tpl-1",
    runBy: "user-1",
    inputParams: { foo: "bar" },
    orgId: TEST_ORG_ID,
    ...overrides,
  };
}

describe("runAgentRunTriggerReleaseJob - recurring clones orgId", () => {
  it("createAgentRunPendingInput receives sourceRun.orgId", async () => {
    trigger.readRunTriggerByRunId.mockResolvedValueOnce(makeRecurringTrigger());
    store.readAgentRunById.mockResolvedValueOnce(makeSourceRun());
    store.createAgentRunPendingInput.mockResolvedValueOnce({
      id: "run-clone-1",
      templateId: "tpl-1",
      runBy: "user-1",
      orgId: TEST_ORG_ID,
    });

    const { runAgentRunTriggerReleaseJob } = await import("../trigger-release-job");
    await runAgentRunTriggerReleaseJob({ runId: "run-source" }, "job-1");

    expect(store.createAgentRunPendingInput).toHaveBeenCalledTimes(1);
    const call = store.createAgentRunPendingInput.mock.calls[0][0];
    // The new run inherits the source's org.
    expect(call).toMatchObject({
      templateId: "tpl-1",
      runBy: "user-1",
      orgId: TEST_ORG_ID,
    });
  });

  it("refuses to clone when sourceRun.orgId is null (no NULL writes)", async () => {
    trigger.readRunTriggerByRunId.mockResolvedValueOnce(makeRecurringTrigger());
    store.readAgentRunById.mockResolvedValueOnce(makeSourceRun({ orgId: null }));

    const { runAgentRunTriggerReleaseJob } = await import("../trigger-release-job");

    let thrown: unknown = null;
    try {
      await runAgentRunTriggerReleaseJob({ runId: "run-source" }, "job-2");
    } catch (err) {
      thrown = err;
    }
    // Either the function throws OR it skips with no insert. Both honor the
    // "no NULL writes" rule. What it MUST NOT do is call
    // createAgentRunPendingInput with orgId omitted/null/undefined.
    if (store.createAgentRunPendingInput.mock.calls.length > 0) {
      const call = store.createAgentRunPendingInput.mock.calls[0][0];
      expect(call.orgId).toBeTruthy();
      expect(typeof call.orgId).toBe("string");
    } else {
      // Either threw or returned silently; the required behavior is that no
      // recurring clone is inserted without an org.
      expect(store.createAgentRunPendingInput).not.toHaveBeenCalled();
    }
    // Suppress unused-variable warning when the implementation throws.
    void thrown;
  });
});

// ---------------------------------------------------------------------------
// cinatra#319 — pre-execution PM check
// ---------------------------------------------------------------------------
function makeScheduledTrigger(
  overrides: Partial<{
    scheduledAt: Date | null;
    cronExpression: string | null;
    jobSchedulerId: string | null;
    enabled: boolean;
  }> = {},
) {
  return {
    runId: "run-source",
    triggerType: "scheduled" as const,
    enabled: overrides.enabled ?? true,
    timezone: "UTC",
    scheduledAt: overrides.scheduledAt ?? new Date("2026-06-25T09:00:00.000Z"),
    cronExpression: overrides.cronExpression ?? null,
    jobSchedulerId: overrides.jobSchedulerId ?? "trigger-release-run-source",
  };
}

async function run() {
  const { runAgentRunTriggerReleaseJob } = await import("../trigger-release-job");
  await runAgentRunTriggerReleaseJob({ runId: "run-source" }, "job-319");
}

describe("runAgentRunTriggerReleaseJob — pre-execution PM check (#319)", () => {
  it("local !enabled short-circuits BEFORE the PM read (PM never consulted)", async () => {
    trigger.readRunTriggerByRunId.mockResolvedValueOnce({
      ...makeRecurringTrigger(),
      enabled: false,
    });
    await run();
    expect(pmBridge.readRunTriggerPmState).not.toHaveBeenCalled();
    expect(enqueue.enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("no-provider → fires normally (recurring clone proceeds)", async () => {
    trigger.readRunTriggerByRunId.mockResolvedValueOnce(makeRecurringTrigger());
    store.readAgentRunById.mockResolvedValueOnce(makeSourceRun());
    store.createAgentRunPendingInput.mockResolvedValueOnce({
      id: "run-clone-x",
      templateId: "tpl-1",
      runBy: "user-1",
      orgId: TEST_ORG_ID,
    });
    pmBridge.readRunTriggerPmState.mockResolvedValueOnce({ kind: "no-provider" });
    await run();
    expect(store.createAgentRunPendingInput).toHaveBeenCalledTimes(1);
  });

  it("unreachable → fail-open fire (scheduled release proceeds)", async () => {
    trigger.readRunTriggerByRunId.mockResolvedValueOnce(makeScheduledTrigger());
    pmBridge.readRunTriggerPmState.mockResolvedValueOnce({
      kind: "unreachable",
      reason: "plane down",
    });
    await run();
    // Scheduled branch: gate released + execution enqueued.
    expect(gate.markTriggerReleased).toHaveBeenCalledWith("run-source");
    expect(enqueue.enqueueAgentRun).toHaveBeenCalledWith(
      { runId: "run-source" },
      { jobId: "agent-builder-run-source" },
    );
  });

  it("deleted (recurring) → tears down scheduler + local trigger + pm-link, skips fire", async () => {
    trigger.readRunTriggerByRunId.mockResolvedValueOnce(makeRecurringTrigger());
    pmBridge.readRunTriggerPmState.mockResolvedValueOnce({ kind: "deleted" });
    await run();
    expect(schedule.cancelTriggerSchedule).toHaveBeenCalledWith({
      jobSchedulerId: "sched_1",
      triggerType: "recurring",
    });
    expect(trigger.deleteRunTriggerByRunId).toHaveBeenCalledWith("run-source");
    expect(pmLink.deletePmLinkByRunId).toHaveBeenCalledWith("run-source");
    // The run must not be stranded armed with no trigger — move armed → stopped.
    expect(store.transitionRunStatus).toHaveBeenCalledWith(
      "run-source",
      "armed",
      "stopped",
    );
    // Skip the fire — no clone, no enqueue.
    expect(store.createAgentRunPendingInput).not.toHaveBeenCalled();
    expect(enqueue.enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("deleted (scheduled) → tears down rows WITHOUT cancelling the in-flight one-shot, skips fire", async () => {
    trigger.readRunTriggerByRunId.mockResolvedValueOnce(makeScheduledTrigger());
    pmBridge.readRunTriggerPmState.mockResolvedValueOnce({ kind: "deleted" });
    await run();
    // The scheduled one-shot is THIS active job — never self-cancel (removal of
    // an active job throws). Only the local rows are torn down.
    expect(schedule.cancelTriggerSchedule).not.toHaveBeenCalled();
    expect(trigger.deleteRunTriggerByRunId).toHaveBeenCalledWith("run-source");
    expect(pmLink.deletePmLinkByRunId).toHaveBeenCalledWith("run-source");
    expect(gate.markTriggerReleased).not.toHaveBeenCalled();
    expect(enqueue.enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("deleted but teardown throws → fails open and FIRES (never strands the run)", async () => {
    trigger.readRunTriggerByRunId.mockResolvedValueOnce(makeScheduledTrigger());
    pmBridge.readRunTriggerPmState.mockResolvedValueOnce({ kind: "deleted" });
    // The scheduled path does not cancel; force a row-teardown failure instead.
    trigger.deleteRunTriggerByRunId.mockRejectedValueOnce(new Error("db down"));
    await run();
    // Fell through to the scheduled release path.
    expect(gate.markTriggerReleased).toHaveBeenCalledWith("run-source");
    expect(enqueue.enqueueAgentRun).toHaveBeenCalled();
  });

  it("paused → skips THIS fire, leaves the schedule, does NOT mutate enabled", async () => {
    trigger.readRunTriggerByRunId.mockResolvedValueOnce(makeRecurringTrigger());
    pmBridge.readRunTriggerPmState.mockResolvedValueOnce({ kind: "paused" });
    await run();
    // No teardown, no refresh, no enqueue, no enabled mutation.
    expect(schedule.cancelTriggerSchedule).not.toHaveBeenCalled();
    expect(schedule.scheduleTrigger).not.toHaveBeenCalled();
    expect(trigger.createOrUpdateRunTrigger).not.toHaveBeenCalled();
    expect(trigger.deleteRunTriggerByRunId).not.toHaveBeenCalled();
    expect(enqueue.enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("rescheduled (recurring) → refreshes via scheduleTrigger with PM cron + persists, skips this tick", async () => {
    trigger.readRunTriggerByRunId.mockResolvedValueOnce(makeRecurringTrigger());
    pmBridge.readRunTriggerPmState.mockResolvedValueOnce({
      kind: "rescheduled",
      cronExpression: "0 12 * * *",
      scheduledAt: null,
    });
    await run();
    expect(schedule.scheduleTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-source",
        triggerType: "recurring",
        cronExpression: "0 12 * * *",
      }),
    );
    expect(trigger.createOrUpdateRunTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-source",
        triggerType: "recurring",
        cronExpression: "0 12 * * *",
        jobSchedulerId: "sched_new",
      }),
    );
    // Refresh-then-skip — no clone this tick.
    expect(store.createAgentRunPendingInput).not.toHaveBeenCalled();
    expect(enqueue.enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("rescheduled (scheduled, FUTURE instant) → persists the new instant + skips, NO inline BullMQ re-arm (id hazard) and never fires the old tick", async () => {
    const newMs = Date.now() + 60 * 60 * 1000;
    const future = new Date(newMs).toISOString();
    trigger.readRunTriggerByRunId.mockResolvedValueOnce(makeScheduledTrigger());
    pmBridge.readRunTriggerPmState.mockResolvedValueOnce({
      kind: "rescheduled",
      cronExpression: null,
      scheduledAt: future,
    });
    await run();
    // No inline re-arm: never self-cancel the active one-shot, never re-add a
    // BullMQ job (reusing the deterministic id no-ops; a unique id diverges).
    expect(schedule.cancelTriggerSchedule).not.toHaveBeenCalled();
    expect(schedule.scheduleTrigger).not.toHaveBeenCalled();
    expect(bg.enqueueBackgroundJob).not.toHaveBeenCalled();
    // Persist the corrected instant + clear releasedAt; keep the prior id (the
    // in-flight one-shot is completing; reconcile #318 re-arms the delayed job).
    expect(trigger.createOrUpdateRunTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-source",
        triggerType: "scheduled",
        scheduledAt: new Date(newMs),
        jobSchedulerId: "trigger-release-run-source",
        releasedAt: null,
      }),
    );
    // Skip — never fire the old tick.
    expect(gate.markTriggerReleased).not.toHaveBeenCalled();
    expect(enqueue.enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("rescheduled (scheduled, NOW/PAST instant) → fires this tick", async () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    trigger.readRunTriggerByRunId.mockResolvedValueOnce(makeScheduledTrigger());
    pmBridge.readRunTriggerPmState.mockResolvedValueOnce({
      kind: "rescheduled",
      cronExpression: null,
      scheduledAt: past,
    });
    await run();
    // Past instant → fire normally (no re-arm).
    expect(schedule.scheduleTrigger).not.toHaveBeenCalled();
    expect(gate.markTriggerReleased).toHaveBeenCalledWith("run-source");
    expect(enqueue.enqueueAgentRun).toHaveBeenCalled();
  });

  it("present → fires normally (scheduled release)", async () => {
    trigger.readRunTriggerByRunId.mockResolvedValueOnce(makeScheduledTrigger());
    pmBridge.readRunTriggerPmState.mockResolvedValueOnce({ kind: "present" });
    await run();
    expect(gate.markTriggerReleased).toHaveBeenCalledWith("run-source");
    expect(enqueue.enqueueAgentRun).toHaveBeenCalled();
  });
});
