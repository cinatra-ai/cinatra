// cinatra#4150 (A5): the artifact-review resume delivery refuses a run held at a publish
// decision. The intent stays pending ("retryable"); nothing is sent into the held
// context and nothing is marked delivered. The harness is the one of
// artifact-review-resume-delivery.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildReviewApproveEnvelope } from "@/lib/artifacts/artifact-review-rejection";

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByTaskId: vi.fn(),
  setAgentRunTokenHash: vi.fn(async () => {}),
  readAgentTemplateById: vi.fn(),
  transitionRunStatus: vi.fn(async () => undefined),
}));
vi.mock("../store", () => storeMock);
vi.mock("../run-produced-review-hold", () => ({
  holdRunForProducedReview: vi.fn(async () => ({ held: false, reason: "no-produced-output" })),
  releaseHeldRun: vi.fn(async () => ({ released: false, reason: "not-parked" })),
  readGateRunOwner: vi.fn(async () => null),
  listReleasableHeldRuns: vi.fn(async () => []),
}));
vi.mock("../agent-run-serde", async (orig) => ({
  ...(await orig<typeof import("../agent-run-serde")>()),
  assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
}));
vi.mock("../wayflow-url", () => ({
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  WAYFLOW_A2A_TIMEOUT_MS: 86_400_000,
  createWayflowFetch: vi.fn(() => globalThis.fetch),
}));

const gateStoreMock = vi.hoisted(() => ({
  claimPendingResumeIntents: vi.fn(),
  listReviewGatesForRun: vi.fn(async (): Promise<unknown[]> => []),
  markResumeIntentDelivered: vi.fn(async () => true),
}));
vi.mock("../artifact-review-gate-store", () => gateStoreMock);

const decisions = vi.hoisted(() => ({
  readLatestDecisionForRun: vi.fn(async (): Promise<unknown> => null),
  listDueParked: vi.fn(async (): Promise<unknown[]> => []),
  listSettledWithWaitingRun: vi.fn(async (): Promise<unknown[]> => []),
  decide: vi.fn(),
}));
vi.mock("../publish-decision-store", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readLatestDecisionForRun: decisions.readLatestDecisionForRun,
  listDueParked: decisions.listDueParked,
  listSettledWithWaitingRun: decisions.listSettledWithWaitingRun,
  decide: decisions.decide,
}));

const { sendTaskSpy, handleWayflowTaskStateSpy } = vi.hoisted(() => ({
  sendTaskSpy: vi.fn(async (_req: unknown) => ({ id: "task-x", status: { state: "completed" } })),
  handleWayflowTaskStateSpy: vi.fn(async () => undefined),
}));
vi.mock("@cinatra-ai/a2a", () => ({
  createExternalA2AClient: vi.fn(async () => ({ sendTask: sendTaskSpy })),
  resolveRunIdByWayflowTaskId: vi.fn(async () => null),
  resolveLatestWayflowGateTaskId: vi.fn(async () => "task-1"),
}));
vi.mock("../execution", () => ({ handleWayflowTaskState: handleWayflowTaskStateSpy }));

import { deliverArtifactReviewResumeIntent, sweepExpiredPublishDecisionsOnce } from "../artifact-review-resume-delivery";
import type { ResumeIntentRow } from "../artifact-review-gate-store";

function intent(): ResumeIntentRow {
  return {
    gateId: "gate-1",
    runId: "run-1",
    reviewTaskId: "wayflow-task-1",
    kind: "approve",
    responseText: JSON.stringify(
      buildReviewApproveEnvelope({ reviewTaskId: "wayflow-task-1", comment: null, targets: [] }),
    ),
    status: "delivering",
    attempts: 1,
    leaseToken: "lease-abc",
    leaseExpiresAt: new Date(Date.now() + 60_000),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  storeMock.readAgentRunByTaskId.mockResolvedValue({
    id: "run-1",
    templateId: "tmpl-1",
    status: "pending_approval",
    a2aTaskId: "task-1",
    a2aContextId: "ctx-1",
    orgId: "org-1",
  });
  storeMock.readAgentTemplateById.mockResolvedValue({
    id: "tmpl-1",
    packageName: "@cinatra-ai/web-research-agent",
    sourceType: "internal",
  });
  gateStoreMock.markResumeIntentDelivered.mockResolvedValue(true);
  gateStoreMock.listReviewGatesForRun.mockResolvedValue([
    { runId: "run-1", orgId: "org-1", reviewTaskId: "wayflow-task-1", status: "resolved",
      pinnedTargets: [{ artifactId: "post", representationRevisionId: "r1" }] },
  ]);
  decisions.readLatestDecisionForRun.mockResolvedValue(null);
  decisions.listDueParked.mockResolvedValue([]);
  decisions.listSettledWithWaitingRun.mockResolvedValue([]);
  storeMock.transitionRunStatus.mockResolvedValue(undefined);
});

describe("the resume delivery and a publish decision", () => {
  it.each(["parked", "declined", "expired", "run_ended"])(
    "a run whose newest decision is %s keeps its intent pending and is sent nothing",
    async (status) => {
      decisions.readLatestDecisionForRun.mockResolvedValue({ id: "d1", runId: "run-1", status });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        expect(await deliverArtifactReviewResumeIntent(intent())).toBe("retryable");
        const refused = warn.mock.calls.map((c) => String(c[0])).filter((line) => line.includes("publish_decision_required"));
        expect(refused).toHaveLength(1);
        expect(refused[0]).not.toMatch(/gate-1|run-1/);
      } finally {
        warn.mockRestore();
      }
      expect(decisions.readLatestDecisionForRun).toHaveBeenCalledWith("run-1");
      expect(sendTaskSpy).not.toHaveBeenCalled();
      expect(handleWayflowTaskStateSpy).not.toHaveBeenCalled();
      expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
    },
  );

  it("an unreadable decision record sends nothing either: the intent stays pending, and no id or store error is logged", async () => {
    decisions.readLatestDecisionForRun.mockRejectedValue(new Error("db down: run-1"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("retryable");
      const lines = warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(lines).toContain("the publish hold could not be checked");
      expect(lines).not.toMatch(/db down|gate-1|run-1/);
    } finally {
      warn.mockRestore();
    }
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
  });

  it("a run with no decision, or a released one, is delivered as before", async () => {
    expect(await deliverArtifactReviewResumeIntent(intent())).toBe("delivered");
    decisions.readLatestDecisionForRun.mockResolvedValue({ id: "d1", runId: "run-1", status: "released" });
    expect(await deliverArtifactReviewResumeIntent(intent())).toBe("delivered");
    expect(sendTaskSpy).toHaveBeenCalledTimes(2);
  });
});

// cinatra#4150: the expiry pass as the resume-delivery loop runs it (the boot wrapper is
// driven in src/lib/__tests__/publish-expiry-boot-wrapper.test.ts).
describe("the publish-decision expiry pass of the resume-delivery loop", () => {
  const expiryLines = (log: { mock: { calls: unknown[][] } }) =>
    log.mock.calls.map((c) => String(c[0])).filter((line) => line.includes("[publish-decision-expiry]"));

  it("reads both lists and logs nothing when nothing is due and no stop is unmade", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await sweepExpiredPublishDecisionsOnce();
      expect(expiryLines(log)).toEqual([]);
    } finally {
      log.mockRestore();
    }
    expect(decisions.listDueParked).toHaveBeenCalledWith(50, undefined);
    expect(decisions.listSettledWithWaitingRun).toHaveBeenCalledWith(50, undefined);
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });

  it("stops an expired run under the loop's dispatch authority for the run's org, and logs counts only", async () => {
    decisions.listDueParked.mockResolvedValueOnce([{ id: "d1", runId: "run-1", status: "parked" }]);
    storeMock.readAgentRunById.mockResolvedValueOnce({ id: "run-1", orgId: "org-1", status: "pending_approval" });
    decisions.decide.mockResolvedValueOnce({ outcome: "won", decision: { id: "d1", status: "expired" } });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await sweepExpiredPublishDecisionsOnce();
      expect(expiryLines(log)).toEqual(["[publish-decision-expiry] due=1 expired=1 run_ended=0 lost=0 failed=0 stopped=0"]);
    } finally {
      log.mockRestore();
    }
    expect(decisions.decide).toHaveBeenCalledWith("d1", { from: "parked", to: "expired", actor: null });
    const [runId, from, to, , authority] = storeMock.transitionRunStatus.mock.calls[0] as unknown as [
      string, string, string, unknown, { orgId?: string },
    ];
    expect([runId, from, to]).toEqual(["run-1", "pending_approval", "stopped"]);
    expect(authority.orgId).toBe("org-1");
  });

  it("a pass whose due list cannot be read rejects (the boot wrapper logs it and drains the intents)", async () => {
    decisions.listDueParked.mockRejectedValueOnce(new Error("db down"));
    await expect(sweepExpiredPublishDecisionsOnce()).rejects.toThrow("db down");
  });
});

// cinatra#4150 PR 3a, pre-review 2 finding 3: on a template that lists publishing steps the delivery claims the run
// (pending_approval -> running) right before the send and reads the hold again, so a decision another resume parked
// after the first read refuses the send. A send that fails after the claim leaves the run running (finding 2).
describe("the resume delivery on a publishing template", () => {
  const moves = () => storeMock.transitionRunStatus.mock.calls.map((c) => (c as unknown[]).slice(0, 3));

  beforeEach(() => {
    // Once-answers a case leaves (a red run over older code) must not feed the next case.
    storeMock.transitionRunStatus.mockReset().mockResolvedValue(undefined);
    decisions.readLatestDecisionForRun.mockReset().mockResolvedValue(null);
    storeMock.readAgentTemplateById.mockResolvedValue({
      id: "tmpl-1",
      packageName: "test-publishing-agent",
      sourceType: "internal",
      publishingSteps: ["publish"],
    });
  });

  it("claims the run before the send, reads the hold after the claim, and hands running to the task handler", async () => {
    expect(await deliverArtifactReviewResumeIntent(intent())).toBe("delivered");
    expect(moves()).toEqual([["run-1", "pending_approval", "running"]]);
    expect(decisions.readLatestDecisionForRun).toHaveBeenCalledTimes(2);
    expect(storeMock.transitionRunStatus.mock.invocationCallOrder[0]!).toBeLessThan(
      decisions.readLatestDecisionForRun.mock.invocationCallOrder[1]!,
    );
    expect(decisions.readLatestDecisionForRun.mock.invocationCallOrder[1]!).toBeLessThan(sendTaskSpy.mock.invocationCallOrder[0]!);
    expect(handleWayflowTaskStateSpy).toHaveBeenCalledWith(expect.objectContaining({ fromStatus: "running" }));
  });

  it("a decision parked by another resume after the first read keeps the intent pending, sends nothing and puts the run back", async () => {
    decisions.readLatestDecisionForRun.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "d1", runId: "run-1", status: "parked" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("retryable");
    } finally {
      warn.mockRestore();
    }
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
    expect(moves()).toEqual([["run-1", "pending_approval", "running"], ["run-1", "running", "pending_approval"]]);
  });

  it("a run another resume holds keeps the intent pending and is sent nothing", async () => {
    storeMock.transitionRunStatus.mockRejectedValueOnce(Object.assign(new Error("stale"), { code: "stale_from_status" }));
    expect(await deliverArtifactReviewResumeIntent(intent())).toBe("retryable");
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(decisions.readLatestDecisionForRun).toHaveBeenCalledTimes(1);
  });

  it("a send that fails after the claim is not put back: the run stays running", async () => {
    sendTaskSpy.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(deliverArtifactReviewResumeIntent(intent())).rejects.toThrow("socket hang up");
    expect(moves()).toEqual([["run-1", "pending_approval", "running"]]);
    expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
  });
});
