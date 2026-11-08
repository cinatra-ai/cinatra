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
  // The conversation's comment (the card's composer) keeps main's road
  // (cinatra#2063, #4339): on a single-target lifecycle
  // gate its typed words are the change request, on the typed road.
  it("retains the explicit lifecycle prompt-window changes_requested road", async () => {
    await submitReviewDecisionAction("run", "task", "conversation-comment", "make the title shorter");
    expect(p.changes).toHaveBeenCalledWith({ runId: "run", reviewTaskId: "task", baseTarget: { artifactId: "artifact", representationRevisionId: "revision" }, feedback: "make the title shorter", origin: "typed", actorCtx: actor });
    expect(p.decision).not.toHaveBeenCalled();
    expect(p.enforce).toHaveBeenCalledWith({ runId: "run", op: "respondToHitl", actorCtx: actor });
  });
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

// THE TWO CHANNELS (cinatra#3080). The Note field's Comment button only
// annotates; the conversation's comment keeps the change road on a lifecycle
// gate and on a declared review's later leg; Regenerate stays its own action.
describe("the conversation's comment is its own submission, and the Note-field Comment only annotates", () => {
  const LEG2 = "wayflow-task-7#2";
  it("the Note-field Comment on a declared review's later leg annotates and never reaches the change road", async () => {
    orchestration.auto = false;
    expect(await submitReviewDecisionAction("run", LEG2, "comment", "Make the sky darker")).toEqual({ kind: "annotated" });
    expect(p.changes).not.toHaveBeenCalled();
    expect(p.decision).toHaveBeenCalledWith({ decision: expect.objectContaining({ reviewTaskId: LEG2, disposition: "comment", comment: "Make the sky darker" }), actorCtx: actor });
  });
  it("the conversation's comment on a declared review's later leg takes the typed change road", async () => {
    orchestration.auto = false;
    expect(await submitReviewDecisionAction("run", LEG2, "conversation-comment", "  Make the sky darker  ")).toEqual({ kind: "changes-requested", status: "requested", idempotent: false });
    expect(p.changes).toHaveBeenCalledTimes(1);
    expect(p.changes).toHaveBeenCalledWith({ runId: "run", reviewTaskId: LEG2, baseTarget: { artifactId: "artifact", representationRevisionId: "revision" }, feedback: "Make the sky darker", origin: "typed", actorCtx: actor });
    expect(p.decision).not.toHaveBeenCalled();
  });
  it("Regenerate on a declared review's later leg is still refused with its reason", async () => {
    orchestration.auto = false;
    expect(await submitReviewDecisionAction("run", LEG2, "regenerate", "Make the sky darker")).toEqual({ kind: "error", message: REGENERATE_NOT_ON_THIS_REVIEW });
    expect(p.changes).not.toHaveBeenCalled(); expect(p.decision).not.toHaveBeenCalled();
  });
  it("the conversation's comment on the post's own leg keeps its plain note", async () => {
    orchestration.auto = false;
    expect(await submitReviewDecisionAction("run", "wayflow-task-7", "conversation-comment", "Tighten the intro")).toEqual({ kind: "annotated" });
    expect(p.changes).not.toHaveBeenCalled();
    expect(p.decision).toHaveBeenCalledWith({ decision: expect.objectContaining({ reviewTaskId: "wayflow-task-7", disposition: "comment", comment: "Tighten the intro" }), actorCtx: actor });
  });
  it("the conversation's comment on a batch gate, or with no words, is a plain note", async () => {
    orchestration.batch = true;
    expect(await submitReviewDecisionAction("run", "task", "conversation-comment", "again")).toEqual({ kind: "annotated" });
    orchestration.batch = false;
    for (const note of ["", "   ", null]) {
      expect(await submitReviewDecisionAction("run", "task", "conversation-comment", note)).toEqual({ kind: "annotated" });
    }
    expect(p.changes).not.toHaveBeenCalled();
    expect(p.decision).toHaveBeenCalledTimes(4);
  });
  it("the conversation's comment on a gate pinning two targets is a plain note", async () => {
    const targets = [{ artifactId: "a", representationRevisionId: "r1" }, { artifactId: "b", representationRevisionId: "r2" }];
    p.pinned.mockResolvedValue(targets);
    expect(await submitReviewDecisionAction("run", "task", "conversation-comment", "again")).toEqual({ kind: "annotated" });
    expect(p.changes).not.toHaveBeenCalled();
  });
  it("the conversation's comment carries no prompt and no suggestion partition", async () => {
    await submitReviewDecisionAction("run", "task", "conversation-comment", "shorter", undefined, null, "a red fox");
    expect(p.changes.mock.calls[0][0]).not.toHaveProperty("prompt");
    p.changes.mockClear();
    expect(await submitReviewDecisionAction("run", "task", "conversation-comment", "shorter", undefined, { accepted: ["s1"], dismissed: [] })).toMatchObject({ kind: "error" });
    expect(p.pinned).toHaveBeenCalledTimes(1); expect(p.changes).not.toHaveBeenCalled();
  });
});
