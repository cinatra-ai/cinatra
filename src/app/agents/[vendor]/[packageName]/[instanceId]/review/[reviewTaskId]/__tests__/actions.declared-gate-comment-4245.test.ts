import { beforeEach, describe, expect, it, vi } from "vitest";

// cinatra#4245 — the review action routes a typed comment on a review step a
// flow declares in its own template (a `wayflow-` gate) to the change-request
// road; every ineligible case keeps the unchanged annotation road.
const p = vi.hoisted(() => ({
  enforce: vi.fn(), pinned: vi.fn(), decision: vi.fn(), changes: vi.fn(), actor: vi.fn(), fence: true,
}));
vi.mock("@/app/artifacts/[id]/review-gate-ports", () => ({
  enforceReviewDecisionAccess: p.enforce, readReviewGatePinnedTargets: p.pinned,
  submitReviewDecision: p.decision, submitReviewSurfaceChangesRequested: p.changes,
}));
vi.mock("../review-actor", () => ({ resolveReviewActorContext: p.actor }));
vi.mock("@/lib/lifecycle/lifecycle-activation", () => ({ isLifecycleReviewOrchestrationActive: () => p.fence }));
vi.mock("@/lib/lifecycle/lifecycle-orchestration", () => ({
  isAutoReviewTaskId: (id: string) => id.startsWith("lifecycle-review:"),
  isBatchAutoReviewTaskId: () => false,
}));
import { submitReviewDecisionAction } from "../actions";

const actor = { orgId: "org", actor: { userId: "reviewer" }, roleHints: [] };
const TASK = "wayflow-review-step";
const target = { artifactId: "artifact-post", representationRevisionId: "revision-1" };

beforeEach(() => {
  vi.clearAllMocks();
  p.fence = true;
  p.actor.mockResolvedValue(actor);
  p.enforce.mockResolvedValue({ ok: true });
  p.pinned.mockResolvedValue([target]);
  p.decision.mockResolvedValue({ ok: true, idempotent: false, fingerprint: "comment", plan: {} });
  p.changes.mockResolvedValue({ ok: true, repairId: "repair-1", status: "requested", idempotent: false });
});

describe("cinatra#4245 — a comment on a declared review gate", () => {
  it("an eligible comment becomes a change request", async () => {
    const outcome = await submitReviewDecisionAction("run", TASK, "comment", "  Shorten the second paragraph.  ");
    expect(p.changes).toHaveBeenCalledWith({ runId: "run", reviewTaskId: TASK, baseTarget: target,
      feedback: "Shorten the second paragraph.", actorCtx: actor });
    expect(outcome).toEqual({ kind: "changes-requested", status: "requested", idempotent: false });
    expect(p.decision).not.toHaveBeenCalled();
    expect(p.enforce).toHaveBeenCalledWith({ runId: "run", op: "respondToHitl", actorCtx: actor });
  });

  it("a store refusal (not eligible) keeps the annotation road", async () => {
    p.changes.mockResolvedValue({ ok: false, code: "declared-gate-not-eligible", error: "not eligible" });
    const outcome = await submitReviewDecisionAction("run", TASK, "comment", "Shorten it.");
    expect(outcome).toEqual({ kind: "annotated" });
    expect(p.decision).toHaveBeenCalledWith({ decision: expect.objectContaining({ disposition: "comment", comment: "Shorten it.",
      reviewedTargets: [target] }), actorCtx: actor });
  });

  it("an empty comment stays an annotation", async () => {
    expect(await submitReviewDecisionAction("run", TASK, "comment", "   ")).toEqual({ kind: "annotated" });
    expect(p.changes).not.toHaveBeenCalled();
  });

  it("a gate that pins two targets stays an annotation", async () => {
    p.pinned.mockResolvedValue([target, { artifactId: "artifact-page", representationRevisionId: "revision-2" }]);
    expect(await submitReviewDecisionAction("run", TASK, "comment", "Shorten it.")).toEqual({ kind: "annotated" });
    expect(p.changes).not.toHaveBeenCalled();
  });

  it("with the fence off, a comment stays an annotation", async () => {
    p.fence = false;
    expect(await submitReviewDecisionAction("run", TASK, "comment", "Shorten it.")).toEqual({ kind: "annotated" });
    expect(p.changes).not.toHaveBeenCalled();
  });

  it("a comment on a gate that is neither declared nor automatic stays an annotation", async () => {
    expect(await submitReviewDecisionAction("run", "hitl-step", "comment", "Shorten it.")).toEqual({ kind: "annotated" });
    expect(p.changes).not.toHaveBeenCalled();
  });
});
