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
const orchestration = vi.hoisted(() => ({ auto: true, batch: false }));
vi.mock("@/lib/lifecycle/lifecycle-orchestration", () => ({ isAutoReviewTaskId: () => orchestration.auto, isBatchAutoReviewTaskId: () => orchestration.batch }));
import { submitReviewDecisionAction } from "../actions";
import { REGENERATE_MULTI_TARGET_REASON, REGENERATE_NEEDS_A_NOTE, REGENERATE_NOT_ON_THIS_REVIEW } from "@/lib/artifacts/review-surface-model";
const actor = { orgId: "org", actor: { userId: "reader" }, roleHints: [] };
beforeEach(() => {
  vi.clearAllMocks(); orchestration.auto = true; orchestration.batch = false;
  p.actor.mockResolvedValue(actor); p.enforce.mockReset(); p.enforce.mockResolvedValue({ ok: true });
  p.pinned.mockResolvedValue([{ artifactId: "artifact", representationRevisionId: "revision" }]);
  p.decision.mockResolvedValue({ ok: true, kind: "annotated" });
  p.changes.mockResolvedValue({ ok: true, status: "requested", idempotent: false });
});
describe("R2a compatibility before the complete §VI floor", () => {
  it("a Comment with words changes nothing: it reaches the decision core as an annotation and never the change road", async () => {
    expect(await submitReviewDecisionAction("run", "task", "comment", "make the title shorter")).toEqual({ kind: "annotated" });
    expect(p.changes).not.toHaveBeenCalled();
    expect(p.decision).toHaveBeenCalledWith({ decision: expect.objectContaining({ disposition: "comment", comment: "make the title shorter" }), actorCtx: actor });
    expect(p.enforce).toHaveBeenCalledWith({ runId: "run", op: "respondToHitl", actorCtx: actor });
  });
  it("Regenerate calls the change road once with the note, the prompt and approveHitl", async () => {
    expect(await submitReviewDecisionAction("run", "task", "regenerate", "  make the title shorter  ", undefined, null, " a red fox in snow ")).toEqual({ kind: "changes-requested", status: "requested", idempotent: false });
    expect(p.changes).toHaveBeenCalledTimes(1);
    expect(p.changes).toHaveBeenCalledWith({ runId: "run", reviewTaskId: "task", baseTarget: { artifactId: "artifact", representationRevisionId: "revision" }, feedback: "make the title shorter", prompt: "a red fox in snow", actorCtx: actor });
    expect(p.decision).not.toHaveBeenCalled();
    expect(p.enforce).toHaveBeenCalledWith({ runId: "run", op: "approveHitl", actorCtx: actor });
  });
  it("Regenerate with an empty note is refused before any read", async () => {
    expect(await submitReviewDecisionAction("run", "task", "regenerate", "   ")).toEqual({ kind: "error", message: REGENERATE_NEEDS_A_NOTE });
    expect(p.actor).not.toHaveBeenCalled(); expect(p.enforce).not.toHaveBeenCalled(); expect(p.pinned).not.toHaveBeenCalled();
    expect(p.changes).not.toHaveBeenCalled(); expect(p.decision).not.toHaveBeenCalled();
  });
  it("Regenerate on a gate pinning two targets is refused with the stated reason and Continue still decides it", async () => {
    const targets = [{ artifactId: "a", representationRevisionId: "r1" }, { artifactId: "b", representationRevisionId: "r2" }];
    p.pinned.mockResolvedValue(targets);
    expect(await submitReviewDecisionAction("run", "task", "regenerate", "again")).toEqual({ kind: "error", message: REGENERATE_MULTI_TARGET_REASON });
    expect(p.changes).not.toHaveBeenCalled();
    p.decision.mockResolvedValue({ ok: true, idempotent: false, fingerprint: "continue", plan: {} });
    expect(await submitReviewDecisionAction("run", "task", "continue", null)).toEqual({ kind: "decided", disposition: "approve", idempotent: false });
    expect(p.decision).toHaveBeenCalledWith({ decision: expect.objectContaining({ disposition: "approve", reviewedTargets: targets }), actorCtx: actor });
  });
  it("Regenerate on a batch or a non-lifecycle review is refused with its reason", async () => {
    orchestration.batch = true;
    expect(await submitReviewDecisionAction("run", "task", "regenerate", "again")).toEqual({ kind: "error", message: REGENERATE_NOT_ON_THIS_REVIEW });
    orchestration.batch = false; orchestration.auto = false;
    expect(await submitReviewDecisionAction("run", "task", "regenerate", "again")).toEqual({ kind: "error", message: REGENERATE_NOT_ON_THIS_REVIEW });
    expect(p.changes).not.toHaveBeenCalled(); expect(p.decision).not.toHaveBeenCalled();
  });
  it("a reader with respond access only cannot Regenerate", async () => {
    p.enforce.mockImplementation(async ({ op }: { op: string }) => (op === "respondToHitl" ? { ok: true } : { ok: false }));
    expect((await submitReviewDecisionAction("run", "task", "regenerate", "again")).kind).toBe("not-permitted");
    expect(p.enforce).toHaveBeenCalledWith({ runId: "run", op: "approveHitl", actorCtx: actor });
    expect(p.pinned).not.toHaveBeenCalled(); expect(p.changes).not.toHaveBeenCalled();
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
