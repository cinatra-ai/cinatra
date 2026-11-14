import { beforeEach, describe, expect, it, vi } from "vitest";
const p = vi.hoisted(() => ({
  enforce: vi.fn(), pinned: vi.fn(), decision: vi.fn(), changes: vi.fn(), actor: vi.fn(),
}));
vi.mock("@/app/artifacts/[id]/review-gate-ports", () => ({
  enforceReviewDecisionAccess: p.enforce, readReviewGatePinnedTargets: p.pinned,
  submitReviewDecision: p.decision, submitReviewSurfaceChangesRequested: p.changes,
}));
vi.mock("../review-actor", () => ({ resolveReviewActorContext: p.actor }));
vi.mock("@/lib/lifecycle/lifecycle-activation", () => ({ isLifecycleReviewOrchestrationActive: () => true }));
vi.mock("@/lib/lifecycle/lifecycle-orchestration", () => ({ isAutoReviewTaskId: () => true, isBatchAutoReviewTaskId: () => false }));
import { submitReviewDecisionAction } from "../actions";
const actor = { orgId: "org", actor: { userId: "reader" }, roleHints: [] };
beforeEach(() => {
  vi.clearAllMocks(); p.actor.mockResolvedValue(actor); p.enforce.mockResolvedValue({ ok: true });
  p.pinned.mockResolvedValue([{ artifactId: "artifact", representationRevisionId: "revision" }]);
  p.decision.mockResolvedValue({ ok: true, kind: "annotated" });
  p.changes.mockResolvedValue({ ok: true, status: "requested", idempotent: false });
});
describe("R2a compatibility before the complete §VI floor", () => {
  it("retains the explicit lifecycle prompt-window changes_requested road", async () => {
    await submitReviewDecisionAction("run", "task", "comment", "make the title shorter");
    expect(p.changes).toHaveBeenCalledWith({ runId: "run", reviewTaskId: "task", baseTarget: { artifactId: "artifact", representationRevisionId: "revision" }, feedback: "make the title shorter", actorCtx: actor });
    expect(p.decision).not.toHaveBeenCalled();
    expect(p.enforce).toHaveBeenCalledWith({ runId: "run", op: "respondToHitl", actorCtx: actor });
  });
  it("an untouched producer prefill submits no feedback and stays annotation-only", async () => {
    await submitReviewDecisionAction("run", "task", "comment", null);
    expect(p.changes).not.toHaveBeenCalled();
    expect(p.decision).toHaveBeenCalledWith({ decision: expect.objectContaining({ disposition: "comment", comment: null }), actorCtx: actor });
  });
  it("retains Continue's approve persistence and full frozen target set", async () => {
    p.decision.mockResolvedValue({ ok: true, idempotent: false, fingerprint: "continue", plan: {} });
    const targets = [{ artifactId: "a", representationRevisionId: "r1" }, { artifactId: "b", representationRevisionId: "r2" }];
    p.pinned.mockResolvedValue(targets);
    expect(await submitReviewDecisionAction("run", "task", "continue", null)).toEqual({ kind: "decided", disposition: "approve", idempotent: false });
    expect(p.decision).toHaveBeenCalledWith({ decision: expect.objectContaining({ disposition: "approve", reviewedTargets: targets }), actorCtx: actor });
    expect(p.enforce).toHaveBeenCalledWith({ runId: "run", op: "approveHitl", actorCtx: actor });
  });
  it("new Reject cannot read or mutate a gate even with a valid actor", async () => {
    expect((await submitReviewDecisionAction("run", "task", "reject", "no")).kind).toBe("error");
    expect(p.pinned).not.toHaveBeenCalled(); expect(p.decision).not.toHaveBeenCalled(); expect(p.changes).not.toHaveBeenCalled();
  });
  it("denial remains uniform before target existence can be read", async () => {
    p.actor.mockResolvedValue(null);
    expect((await submitReviewDecisionAction("run", "task", "comment", "words")).kind).toBe("not-permitted");
    expect(p.enforce).not.toHaveBeenCalled(); expect(p.pinned).not.toHaveBeenCalled();
  });
});
