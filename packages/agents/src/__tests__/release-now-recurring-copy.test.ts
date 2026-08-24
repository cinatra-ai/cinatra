/**
 * RELEASE NOW ON A RECURRING SCHEDULE STARTS ONE COPY, AND LEAVES THE SCHEDULE
 * RUNNING (cinatra#2928, epic #2926 W2a).
 *
 * WHAT WENT WRONG. Release now opened the gate on the schedule-DEFINING run and
 * moved it `armed → queued`. For a one-off that is exactly right: its trigger
 * names a single firing and releasing it IS that firing. For a RECURRING
 * schedule it is not: the defining run is the schedule's own representation, so
 * spending it left the schedule reading as no longer armed — the person asked
 * for "run it once, now" and got "run it once, now, and stop".
 *
 * A recurring tick already knows how to make a fresh copy. This is the same act
 * asked for by a person instead of by the clock, so it goes through the same
 * launch entry, and the defining run is left exactly as it was.
 *
 * Only the DB seams and the session are stubbed; `releaseTriggerNow` runs for
 * real, and so does the coordinator's launch/advance pair.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const RUN_ID = "run-2928-recurring";
const COPY_ID = "run-2928-copy";
const USER = "admin-2928";
const ORG = "org-2928";

const { StubRunTransitionError } = vi.hoisted(() => ({
  StubRunTransitionError: class RunTransitionError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = "RunTransitionError";
      this.code = code;
    }
  },
}));

const readAgentRunById = vi.fn();
const transitionRunStatus = vi.fn();
const createAgentRunPendingInput = vi.fn();
const readRunTriggerByRunId = vi.fn();
const createOrUpdateRunTrigger = vi.fn();
const markTriggerReleased = vi.fn();
const enqueueAgentRun = vi.fn();
const requireAuthSession = vi.fn();
const verifySessionAuthority = vi.fn();
const readOrgArchivedAtForDispatch = vi.fn(async (): Promise<boolean> => false);

vi.mock("../store", () => ({
  RunTransitionError: StubRunTransitionError,
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
  readAgentTemplateBySlug: vi.fn(async () => null),
  readAgentTemplateById: vi.fn(async () => null),
  transitionRunStatus: (...a: unknown[]) => transitionRunStatus(...a),
  clearAgentRunFailureMetadata: vi.fn(async () => undefined),
  createAgentRunPendingInput: (...a: unknown[]) => createAgentRunPendingInput(...a),
  createAgentRun: vi.fn(),
  slugifyAgentTemplateName: (n: string) => n,
  readAllHitlPromptsForRun: vi.fn(async () => []),
}));
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: (...a: unknown[]) => requireAuthSession(...a),
}));
vi.mock("@/lib/org-write/authority", () => ({
  verifySessionAuthority: (...a: unknown[]) => verifySessionAuthority(...a),
}));
vi.mock("@/lib/org-write/run-creation-authority", () => ({
  resolveRunCreationAuthority: vi.fn(async () => ({ kind: "system" })),
}));
vi.mock("../auth-policy", () => ({ resolveTemplateVisibilityActor: vi.fn(async () => null) }));
vi.mock("../recommendation-hold", () => ({
  maybeHoldRunForRecommendation: vi.fn(async () => ({ held: false })),
  readRecommendationParkForRun: vi.fn(async () => null),
}));
vi.mock("@/lib/agent-run-enqueue", () => ({
  enqueueAgentRun: (...a: unknown[]) => enqueueAgentRun(...a),
  enqueueDepsForTemplate: vi.fn(() => ({})),
}));
vi.mock("../trigger-store", () => ({
  readRunTriggerByRunId: (...a: unknown[]) => readRunTriggerByRunId(...a),
  createOrUpdateRunTrigger: (...a: unknown[]) => createOrUpdateRunTrigger(...a),
  deleteRunTriggerByRunId: vi.fn(async () => undefined),
}));
vi.mock("../trigger-schedule", () => ({
  scheduleTrigger: vi.fn(async () => ({ jobSchedulerId: null })),
  cancelTriggerSchedule: vi.fn(async () => undefined),
}));
vi.mock("../trigger-gate", () => ({
  markTriggerReleased: (...a: unknown[]) => markTriggerReleased(...a),
}));
vi.mock("@/lib/pm-integration-providers", () => ({
  syncRunTriggerPmTask: vi.fn(async () => undefined),
  deleteRunTriggerPmTask: vi.fn(async () => undefined),
}));
vi.mock("@/lib/agent-run-readiness", () => ({
  assertAgentRunReadyByPackage: vi.fn(async () => null),
}));
vi.mock("@/lib/org-archive/dispatch-precheck", () => ({
  readOrgArchivedAtForDispatch: () => readOrgArchivedAtForDispatch(),
}));
vi.mock("../agent-run-serde", () => ({
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
  assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
}));

import { releaseTriggerNow } from "../run-actions";

const definingRun = {
  id: RUN_ID,
  templateId: "tmpl-2928",
  orgId: ORG,
  runBy: USER,
  status: "armed",
  inputParams: { idea: "weekly digest" },
  projectId: "proj-2928",
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthSession.mockResolvedValue({
    user: { id: USER, role: "admin" },
    session: { activeOrganizationId: ORG },
  });
  verifySessionAuthority.mockResolvedValue({ kind: "member", userId: USER, orgId: ORG });
  readOrgArchivedAtForDispatch.mockResolvedValue(false);
  readAgentRunById.mockImplementation(async (id: string) =>
    id === RUN_ID ? definingRun : { ...definingRun, id: COPY_ID, status: "queued" },
  );
  createAgentRunPendingInput.mockResolvedValue({
    ...definingRun,
    id: COPY_ID,
    status: "pending_input",
  });
  transitionRunStatus.mockResolvedValue(undefined);
});

describe("release now on a RECURRING schedule", () => {
  beforeEach(() => {
    readRunTriggerByRunId.mockResolvedValue({
      runId: RUN_ID,
      triggerType: "recurring",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      enabled: true,
      releasedAt: null,
      jobSchedulerId: "sched-2928",
    });
  });

  it("creates a COPY of the run rather than spending the schedule-defining one", async () => {
    const result = await releaseTriggerNow({ runId: RUN_ID });

    expect(result.ok).toBe(true);
    expect(createAgentRunPendingInput).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: definingRun.templateId,
        orgId: ORG,
        runBy: USER,
        inputParams: definingRun.inputParams,
        // The copy stays inside the project the schedule belongs to — a copy
        // that widened out of it would be a different run in every way that
        // matters to a reader.
        projectId: "proj-2928",
      }),
      expect.anything(),
    );
  });

  it("LEAVES THE SCHEDULE RUNNING — the defining run is never transitioned", async () => {
    await releaseTriggerNow({ runId: RUN_ID });

    // THE WHOLE POINT. Every transition names the COPY; the defining run keeps
    // its `armed` status, so the next tick fires as it would have.
    for (const call of transitionRunStatus.mock.calls) {
      expect(call[0], "the defining run was moved — the schedule is frozen").toBe(COPY_ID);
    }
    // …and its gate is not opened either: `markTriggerReleased` on the defining
    // run would consume the schedule's own release stamp.
    for (const call of markTriggerReleased.mock.calls) {
      expect(call[0]).toBe(COPY_ID);
    }
  });

  it("starts exactly ONE copy, armed as immediate, and enqueues it once", async () => {
    await releaseTriggerNow({ runId: RUN_ID });

    expect(createAgentRunPendingInput).toHaveBeenCalledTimes(1);
    expect(createOrUpdateRunTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ runId: COPY_ID, triggerType: "immediate", enabled: true }),
    );
    expect(enqueueAgentRun).toHaveBeenCalledTimes(1);
    expect(enqueueAgentRun).toHaveBeenCalledWith(
      { runId: COPY_ID },
      expect.objectContaining({ jobId: `agent-builder-${COPY_ID}` }),
    );
  });
});

describe("a copy whose dispatch fails is never left queued with no job", () => {
  beforeEach(() => {
    readRunTriggerByRunId.mockResolvedValue({
      runId: RUN_ID,
      triggerType: "recurring",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      enabled: true,
      releasedAt: null,
      jobSchedulerId: "sched-2928",
    });
  });

  it("returns the copy to its waiting state — the person can retry it", async () => {
    // THE STATE NOTHING RECOVERS ON ITS OWN. The copy has already been created,
    // armed and had its gate opened by the time the enqueue runs; a Redis or
    // preflight failure there would otherwise leave a `queued` row no worker
    // picks up and no surface offers a way to move.
    enqueueAgentRun.mockRejectedValueOnce(new Error("redis is down"));

    await expect(releaseTriggerNow({ runId: RUN_ID })).rejects.toThrow(/redis is down/);

    // Reverted to the state it was parked at, not left `queued`.
    expect(transitionRunStatus).toHaveBeenCalledWith(
      COPY_ID,
      "queued",
      "pending_input",
      undefined,
      expect.anything(),
    );
    // …and the schedule is STILL not frozen: nothing touched the defining run.
    for (const call of transitionRunStatus.mock.calls) {
      expect(call[0]).toBe(COPY_ID);
    }
  });

  it("fails the copy visibly when it cannot be returned to its waiting state", async () => {
    // The second rung. A terminal, visible run beats a phantom queued one, and
    // every surface already renders a failed run.
    enqueueAgentRun.mockRejectedValueOnce(new Error("redis is down"));
    transitionRunStatus.mockImplementation(async (_id: string, from: string, to: string) => {
      if (from === "queued" && to === "pending_input") {
        throw new Error("the revert failed too");
      }
    });

    await expect(releaseTriggerNow({ runId: RUN_ID })).rejects.toThrow(/redis is down/);

    expect(transitionRunStatus).toHaveBeenCalledWith(
      COPY_ID,
      "queued",
      "failed",
      expect.objectContaining({ error: expect.stringContaining("Dispatch failed") }),
      expect.anything(),
    );
  });

  it("NAMES the run as stranded when it can be landed in no honest state at all", async () => {
    enqueueAgentRun.mockRejectedValueOnce(new Error("redis is down"));
    transitionRunStatus.mockImplementation(async (_id: string, from: string) => {
      if (from === "queued") throw new Error("every recovery write failed");
    });

    await expect(releaseTriggerNow({ runId: RUN_ID })).rejects.toThrow(/STRANDED/);
  });
});

describe("release now on a ONE-OFF schedule is unchanged", () => {
  beforeEach(() => {
    readRunTriggerByRunId.mockResolvedValue({
      runId: RUN_ID,
      triggerType: "scheduled",
      scheduledAt: new Date("2026-09-01T09:00:00Z"),
      timezone: "UTC",
      enabled: true,
      releasedAt: null,
      jobSchedulerId: "sched-2928",
    });
  });

  it("releases the run itself — its trigger names a single firing, and this is it", async () => {
    const result = await releaseTriggerNow({ runId: RUN_ID });

    expect(result.ok).toBe(true);
    expect(createAgentRunPendingInput).not.toHaveBeenCalled();
    expect(markTriggerReleased).toHaveBeenCalledWith(RUN_ID);
    expect(transitionRunStatus).toHaveBeenCalledWith(
      RUN_ID,
      "armed",
      "queued",
      undefined,
      expect.anything(),
    );
    expect(enqueueAgentRun).toHaveBeenCalledWith(
      { runId: RUN_ID },
      expect.objectContaining({ jobId: `agent-builder-${RUN_ID}` }),
    );
  });
});
