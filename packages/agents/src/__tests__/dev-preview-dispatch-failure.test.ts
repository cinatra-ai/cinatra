/**
 * THE STEP-BY-STEP PREVIEW STILL OPENS ON THE RUN THAT EXISTS
 * (cinatra#2928 review, blocker 2).
 *
 * WHAT WENT WRONG. Moving the preview onto the coordinator's launch changed its
 * FAILURE POSTURE while its comment went on describing the old one. A dispatch
 * failure used to be logged and the panel still opened on the created run; the
 * rewritten path returned `{ ok: false }` and discarded the run id — so the run
 * created for the person was left with nothing pointing at it, on the one
 * surface that could have shown it to them.
 *
 * WHAT IS TRUE NOW. The posture the comment always described: logged, and the
 * panel opens. The run is in BETTER shape than before this slice, because the
 * coordinator's ladder has already returned it to `pending_input` — decidable
 * and retryable — instead of leaving it `queued` with no job behind it.
 *
 * The launch NAMES the run it created on the error it rethrows, which is what
 * makes this recoverable without the caller re-implementing creation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const USER = "user-2928";
const ORG = "org-2928";
const RUN_ID = "run-2928-preview";

const { StubRunTransitionError } = vi.hoisted(() => ({
  StubRunTransitionError: class RunTransitionError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.name = "RunTransitionError";
      this.code = code;
    }
  },
}));

const readAgentRunById = vi.fn();
const transitionRunStatus = vi.fn();
const createAgentRunPendingInput = vi.fn();
const enqueueAgentRun = vi.fn();
const requireAuthSession = vi.fn();
const verifySessionAuthority = vi.fn();
const recordRunLifecycleMoment = vi.fn();

vi.mock("../store", () => ({
  RunTransitionError: StubRunTransitionError,
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
  readAgentTemplateBySlug: vi.fn(async () => ({
    id: "tmpl-2928",
    name: "Preview Agent",
    packageName: "@cinatra/preview-agent",
    lifecycleConfig: null,
  })),
  readAgentTemplateById: vi.fn(async () => null),
  transitionRunStatus: (...a: unknown[]) => transitionRunStatus(...a),
  clearAgentRunFailureMetadata: vi.fn(async () => undefined),
  createAgentRunPendingInput: (...a: unknown[]) => createAgentRunPendingInput(...a),
  createAgentRun: vi.fn(),
  recordRunLifecycleMoment: (...a: unknown[]) => recordRunLifecycleMoment(...a),
  slugifyAgentTemplateName: (n: string) => n,
  readAllHitlPromptsForRun: vi.fn(async () => []),
}));
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: (...a: unknown[]) => requireAuthSession(...a),
  getActorContext: vi.fn(async () => undefined),
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
  readRunTriggerByRunId: vi.fn(async () => null),
  createOrUpdateRunTrigger: vi.fn(async () => undefined),
  deleteRunTriggerByRunId: vi.fn(async () => undefined),
}));
vi.mock("../trigger-schedule", () => ({
  scheduleTrigger: vi.fn(async () => ({ jobSchedulerId: null })),
  cancelTriggerSchedule: vi.fn(async () => undefined),
}));
vi.mock("../trigger-gate", () => ({ markTriggerReleased: vi.fn(async () => undefined) }));
vi.mock("@/lib/pm-integration-providers", () => ({
  syncRunTriggerPmTask: vi.fn(async () => undefined),
  deleteRunTriggerPmTask: vi.fn(async () => undefined),
}));
vi.mock("@/lib/agent-run-readiness", () => ({
  assertAgentRunReadyByPackage: vi.fn(async () => null),
}));
vi.mock("@/lib/org-archive/dispatch-precheck", () => ({
  readOrgArchivedAtForDispatch: vi.fn(async () => false),
}));
vi.mock("../agent-run-serde", () => ({
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
  assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
}));

const closeOpenPublishDecisionsOfRun = vi.fn();
vi.mock("../publish-decision-actions", () => ({
  closeOpenPublishDecisionsOfRun: (...a: unknown[]) => closeOpenPublishDecisionsOfRun(...a),
}));

import { resetAgentRun, startDevChildPreviewRun } from "../run-actions";

const createdRun = {
  id: RUN_ID,
  templateId: "tmpl-2928",
  orgId: ORG,
  runBy: USER,
  status: "pending_input",
  inputParams: {},
  lifecycleMoment: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthSession.mockResolvedValue({
    user: { id: USER, role: "admin" },
    session: { activeOrganizationId: ORG },
  });
  verifySessionAuthority.mockResolvedValue({ kind: "session" });
  recordRunLifecycleMoment.mockResolvedValue(undefined);
  createAgentRunPendingInput.mockResolvedValue({ ...createdRun });
  readAgentRunById.mockResolvedValue({ ...createdRun });
  transitionRunStatus.mockResolvedValue(undefined);
  enqueueAgentRun.mockResolvedValue(undefined);
});

describe("startDevChildPreviewRun and a failed dispatch", () => {
  it("opens the panel ON THE RUN THAT EXISTS when the enqueue fails", async () => {
    enqueueAgentRun.mockRejectedValueOnce(new Error("redis unavailable"));

    const result = await startDevChildPreviewRun("@cinatra/preview-agent");

    // THE DOCUMENTED POSTURE. The panel opens, and it opens on the run this
    // call created — the person's only route back to it.
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("the preview refused to open");
    expect(result.runId).toBe(RUN_ID);
    expect(result.templateId).toBe("tmpl-2928");
    expect(result.heldForRecommendation).toBe(false);
    // …and the run is decidable again, not stranded in `queued` with no job.
    expect(transitionRunStatus).toHaveBeenCalledWith(
      RUN_ID,
      "queued",
      "pending_input",
      undefined,
      expect.anything(),
    );
  });

  it("opens the panel even when the launch's own compensation lost its race", async () => {
    // The other rung: the dispatch failed AND the ladder could not put the run
    // back, because another writer had already moved it. The launch rethrows
    // from a different site — and the run it created still exists, so the panel
    // still has somewhere to open.
    enqueueAgentRun.mockRejectedValueOnce(new Error("redis unavailable"));
    transitionRunStatus.mockImplementation(
      async (_id: string, from: string) => {
        if (from === "queued") throw new StubRunTransitionError("stale_from_status");
        return undefined;
      },
    );

    const result = await startDevChildPreviewRun("@cinatra/preview-agent");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("the preview refused to open");
    expect(result.runId).toBe(RUN_ID);
  });

  it("still refuses when the failure landed BEFORE there was a run", async () => {
    // Nothing to open a panel on, so the caller gets the error — the same
    // answer every earlier failure in this function already gives.
    createAgentRunPendingInput.mockRejectedValueOnce(new Error("run.execute refused"));

    const result = await startDevChildPreviewRun("@cinatra/preview-agent");

    expect(result.ok).toBe(false);
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("the ordinary preview is unchanged", async () => {
    const result = await startDevChildPreviewRun("@cinatra/preview-agent");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("the preview refused to open");
    expect(result.runId).toBe(RUN_ID);
    expect(enqueueAgentRun).toHaveBeenCalledTimes(1);
  });
});

// Review finding 1 on cinatra#4150: a retry's reset (failed -> pending_input) closes the publish decision a failed attempt
// left open BEFORE the run moves, so the stale row never reads as the open stop of the run's next attempt.
describe("resetAgentRun closes a failed attempt's open publish decision first", () => {
  const failedRun = { ...createdRun, status: "failed" };
  beforeEach(() => {
    readAgentRunById.mockResolvedValue({ ...failedRun });
    closeOpenPublishDecisionsOfRun.mockResolvedValue(1);
  });

  it("closes the run's open decisions, then moves the run failed -> pending_input", async () => {
    await expect(resetAgentRun({ runId: RUN_ID })).resolves.toEqual({ ok: true });
    expect(closeOpenPublishDecisionsOfRun).toHaveBeenCalledWith(RUN_ID);
    expect(transitionRunStatus).toHaveBeenCalledWith(RUN_ID, "failed", "pending_input", undefined, expect.anything());
    expect(closeOpenPublishDecisionsOfRun.mock.invocationCallOrder[0]!).toBeLessThan(
      transitionRunStatus.mock.invocationCallOrder[0]!,
    );
  });

  it("a fault closing the decision fails the reset, and the run is not moved", async () => {
    closeOpenPublishDecisionsOfRun.mockRejectedValue(new Error("db down"));
    await expect(resetAgentRun({ runId: RUN_ID })).rejects.toThrow("db down");
    expect(transitionRunStatus).not.toHaveBeenCalled();
  });

  it("a run that is not failed is refused, and nothing is closed", async () => {
    readAgentRunById.mockResolvedValue({ ...createdRun, status: "running" });
    await expect(resetAgentRun({ runId: RUN_ID })).resolves.toEqual({ ok: false, error: "run is not in failed state" });
    expect(closeOpenPublishDecisionsOfRun).not.toHaveBeenCalled();
  });
});
