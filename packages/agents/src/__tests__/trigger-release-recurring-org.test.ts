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

vi.mock("../trigger-store", () => trigger);
vi.mock("../trigger-gate", () => gate);
vi.mock("../store", () => store);
vi.mock("@/lib/background-jobs", () => bg);

beforeEach(() => {
  vi.clearAllMocks();
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
