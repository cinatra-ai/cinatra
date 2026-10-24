/**
 * #3035 PICTURE REGENERATION (cinatra#4312). The drawing (app-artifact-review
 * §VI): "Either way Regenerate settles the gate it was pressed on as superseded
 * and mints a successor gate for that same artifact — a fresh review entry
 * beneath the settled one — and no other artifact's review is re-opened."
 *
 * The run is the blog pipeline's marked review step after the W11 fan-out
 * (lifecycle-c-w11-declared-review-targets.test.ts): one gate per artifact, the
 * post's on the step's own task id and the featured image's on `#2`. Regenerate
 * is the decision floor's Comment with a typed note; the decision action is the
 * code under test. The gate ports are an in-memory gate table: a plain comment
 * leaves its gate pending, and the S2 changes_requested road settles the gate
 * and pins the successor over the regenerated revision of the same artifact
 * (the contract of recordChangesRequested + submitRepairResponse, which the
 * lifecycle-repair integration tests own against a real database).
 *
 *   pnpm exec vitest run src/__tests__/lifecycle-c-w11-picture-regenerate-successor-gate-3035.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { declaredReviewPlan, isDeclaredReviewLeg, planPerArtifactReviewGates } from "@/lib/artifacts/artifact-review-target";
import { repairSuccessorReviewTaskId } from "@/lib/lifecycle/lifecycle-orchestration";

type Target = { artifactId: string; representationRevisionId: string };
type Gate = { reviewTaskId: string; status: "pending" | "resolved"; disposition: string | null; targets: Target[] };

const p = vi.hoisted(() => ({ gates: [] as Gate[], fence: true, actor: vi.fn(), changes: vi.fn(), decision: vi.fn() }));

vi.mock("@/app/artifacts/[id]/review-gate-ports", () => ({
  enforceReviewDecisionAccess: async () => ({ ok: true }),
  readReviewGatePinnedTargets: async (_runId: string, reviewTaskId: string) =>
    p.gates.find((g) => g.reviewTaskId === reviewTaskId && g.status === "pending")?.targets ?? null,
  submitReviewDecision: p.decision,
  submitReviewSurfaceChangesRequested: p.changes,
}));
vi.mock("@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-actor", () => ({
  resolveReviewActorContext: p.actor,
}));
vi.mock("@/lib/lifecycle/lifecycle-activation", () => ({ isLifecycleReviewOrchestrationActive: () => p.fence }));

import { submitReviewDecisionAction } from "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/actions";

const RUN = "run-blog-1";
const STEP = "wayflow-task-7";
const POST: Target = { artifactId: "art-post", representationRevisionId: "rev-post-1" };
const FEATURED: Target = { artifactId: "art-img-featured", representationRevisionId: "rev-img-1" };
const REGENERATED: Target = { artifactId: "art-img-featured", representationRevisionId: "rev-img-2" };

const gate = (reviewTaskId: string) => p.gates.find((g) => g.reviewTaskId === reviewTaskId);
const pending = () => p.gates.filter((g) => g.status === "pending");

beforeEach(() => {
  vi.clearAllMocks();
  p.fence = true;
  p.gates = planPerArtifactReviewGates({ reviewTaskId: STEP, targets: [POST, FEATURED] }).map((leg) => ({
    reviewTaskId: leg.reviewTaskId,
    status: "pending" as const,
    disposition: null,
    targets: [...leg.targets],
  }));
  p.actor.mockResolvedValue({ orgId: "org-1", actor: { userId: "reader-1" }, roleHints: [] });
  // The #1807 core: a comment is a non-terminal annotation; Continue resolves.
  p.decision.mockImplementation(async ({ decision }: { decision: { reviewTaskId: string; disposition: string } }) => {
    if (decision.disposition === "approve") {
      Object.assign(gate(decision.reviewTaskId)!, { status: "resolved", disposition: "approve" });
    }
    return { ok: true, idempotent: false };
  });
  // The S2 road: the gate settles and its successor pins the regenerated revision.
  p.changes.mockImplementation(async ({ reviewTaskId }: { reviewTaskId: string }) => {
    Object.assign(gate(reviewTaskId)!, { status: "resolved", disposition: "changes_requested" });
    p.gates.push({
      reviewTaskId: repairSuccessorReviewTaskId("repair-1", 1),
      status: "pending",
      disposition: null,
      targets: [REGENERATED],
    });
    return { ok: true, status: "requested", idempotent: false };
  });
});

describe("#3035 picture regeneration — Regenerate on the featured image mints its successor gate", () => {
  it("the W11 fan-out gave the post and the picture one gate each", () => {
    expect(p.gates.map((g) => g.reviewTaskId)).toEqual([STEP, `${STEP}#2`]);
  });

  it("settles the featured image's gate as superseded and pins one successor for that same artifact", async () => {
    const outcome = await submitReviewDecisionAction(RUN, `${STEP}#2`, "comment", "Make the sky darker");

    expect(gate(`${STEP}#2`)).toMatchObject({ status: "resolved", disposition: "changes_requested" });
    expect(outcome).toEqual({ kind: "changes-requested", status: "requested", idempotent: false });

    const successors = pending().filter((g) => g.reviewTaskId !== STEP);
    expect(successors).toHaveLength(1);
    expect(successors[0].targets).toEqual([REGENERATED]);
    expect(successors[0].targets[0].artifactId).toBe(FEATURED.artifactId);
  });

  it("leaves the post's gate exactly as it was", async () => {
    const before = structuredClone(gate(STEP));
    await submitReviewDecisionAction(RUN, `${STEP}#2`, "comment", "Make the sky darker");
    expect(gate(STEP)).toEqual(before);
    expect(p.changes).toHaveBeenCalledTimes(1);
    expect(p.changes.mock.calls[0][0]).toMatchObject({ runId: RUN, reviewTaskId: `${STEP}#2`, baseTarget: FEATURED });
  });

  it("keeps the run parked at the successor until that gate is continued", async () => {
    await submitReviewDecisionAction(RUN, STEP, "continue", null);
    await submitReviewDecisionAction(RUN, `${STEP}#2`, "comment", "Make the sky darker");
    const successorId = repairSuccessorReviewTaskId("repair-1", 1);
    expect(pending().map((g) => g.reviewTaskId)).toEqual([successorId]);

    await submitReviewDecisionAction(RUN, successorId, "continue", null);
    expect(gate(successorId)).toMatchObject({ status: "resolved", disposition: "approve" });
    expect(pending()).toEqual([]);
  });
});

describe("#3035 picture regeneration — only a witnessed leg of a declared review takes the road", () => {
  const plan = declaredReviewPlan({ runId: RUN, orgId: "org-1", reviewTaskId: STEP, targets: [POST, FEATURED] })!;
  const leg = (target: Target, witness: unknown = plan) => [{ ...target, declaredReviewPlan: witness }];

  it("accepts the picture's leg whose pin carries the family witness", () => {
    expect(isDeclaredReviewLeg({ runId: RUN, orgId: "org-1", reviewTaskId: `${STEP}#2`, pinnedTargets: leg(FEATURED) })).toBe(true);
  });

  // Fold 2 (C3 option B) reverses fold 1's reading: the post's own leg carries the
  // witness too, but it is the plan's first leg and keeps main's plain annotation.
  it("refuses the post's own leg, the plan's first, although its pin carries the witness", () => {
    expect(isDeclaredReviewLeg({ runId: RUN, orgId: "org-1", reviewTaskId: STEP, pinnedTargets: leg(POST) })).toBe(false);
  });

  it("refuses a flow-authored gate with no witness, a foreign witness, or a pin the plan does not name", () => {
    expect(isDeclaredReviewLeg({ runId: RUN, orgId: "org-1", reviewTaskId: STEP, pinnedTargets: [POST] })).toBe(false);
    expect(isDeclaredReviewLeg({ runId: "run-other", orgId: "org-1", reviewTaskId: `${STEP}#2`, pinnedTargets: leg(FEATURED) })).toBe(false);
    expect(isDeclaredReviewLeg({ runId: RUN, orgId: "org-2", reviewTaskId: `${STEP}#2`, pinnedTargets: leg(FEATURED) })).toBe(false);
    expect(isDeclaredReviewLeg({ runId: RUN, orgId: "org-1", reviewTaskId: `${STEP}#2`, pinnedTargets: leg(REGENERATED) })).toBe(false);
    expect(isDeclaredReviewLeg({ runId: RUN, orgId: "org-1", reviewTaskId: `${STEP}#3`, pinnedTargets: leg(FEATURED) })).toBe(false);
    expect(isDeclaredReviewLeg({ runId: RUN, orgId: "org-1", reviewTaskId: "lifecycle-review:evt-1", pinnedTargets: leg(FEATURED) })).toBe(false);
  });
});

describe("#3035 picture regeneration — the witness reader refuses every malformed pin (C2)", () => {
  const plan = declaredReviewPlan({ runId: RUN, orgId: "org-1", reviewTaskId: STEP, targets: [POST, FEATURED] })!;
  const leg2 = (pinnedTargets: unknown) =>
    isDeclaredReviewLeg({ runId: RUN, orgId: "org-1", reviewTaskId: `${STEP}#2`, pinnedTargets });

  it("refuses a gate that pins more than one target, even with the witness on each pin", () => {
    expect(leg2([{ ...FEATURED, declaredReviewPlan: plan }, { ...POST, declaredReviewPlan: plan }])).toBe(false);
    expect(leg2([{ ...FEATURED, declaredReviewPlan: plan }, { ...FEATURED, declaredReviewPlan: plan }])).toBe(false);
  });

  it("refuses pinned targets that are not an array of one valid pin", () => {
    for (const pinned of [null, undefined, "art-img-featured", 7, { ...FEATURED, declaredReviewPlan: plan }, [],
      [null], [{ artifactId: "art-img-featured", declaredReviewPlan: plan }], [{ ...FEATURED, artifactId: "", declaredReviewPlan: plan }]]) {
      expect(leg2(pinned)).toBe(false);
    }
  });

  it("refuses a witness with an extra key, a missing key or a reshaped leg", () => {
    const { legs: _legs, ...noLegs } = plan;
    const { orgId: _orgId, ...noOrg } = plan;
    for (const witness of [
      { ...plan, approvedBy: "reader-1" },
      noLegs,
      noOrg,
      { ...plan, legs: [plan.legs[0]] },
      { ...plan, legs: [...plan.legs, { reviewTaskId: `${STEP}#3`, targets: [REGENERATED] }] },
      { ...plan, legs: plan.legs.map((l) => ({ ...l, note: "x" })) },
      { ...plan, legs: plan.legs.map((l) => ({ ...l, targets: [{ ...l.targets[0], extra: true }] })) },
      { ...plan, legs: [plan.legs[1], plan.legs[0]] },
      { ...plan, baseTaskId: `${STEP}#2` },
      null,
      "witness",
    ]) {
      expect(leg2([{ ...FEATURED, declaredReviewPlan: witness }])).toBe(false);
    }
  });
});

describe("#3035 picture regeneration — the decision action on a declared gate (C2)", () => {
  it("keeps the plain comment when the store refuses the gate as no lifecycle gate", async () => {
    p.changes.mockResolvedValueOnce({ ok: false, code: "not-a-lifecycle-gate", error: "not a lifecycle review gate" });
    const outcome = await submitReviewDecisionAction(RUN, `${STEP}#2`, "comment", "Make the sky darker");

    expect(p.changes).toHaveBeenCalledTimes(1);
    expect(p.decision).toHaveBeenCalledTimes(1);
    expect(p.decision.mock.calls[0][0].decision).toMatchObject({
      runId: RUN, reviewTaskId: `${STEP}#2`, disposition: "comment", comment: "Make the sky darker", reviewedTargets: [FEATURED],
    });
    expect(outcome).toEqual({ kind: "annotated" });
    expect(pending().map((g) => g.reviewTaskId)).toEqual([STEP, `${STEP}#2`]);
  });

  it("blocks without a plain comment when the store refuses the declared gate for another reason", async () => {
    p.changes.mockResolvedValueOnce({ ok: false, code: "gate-not-pending", error: "the review gate is no longer available" });
    const outcome = await submitReviewDecisionAction(RUN, `${STEP}#2`, "comment", "Make the sky darker");

    expect(outcome).toEqual({ kind: "blocked", reason: "no-longer-pending" });
    expect(p.decision).not.toHaveBeenCalled();
  });

  it("sends an empty or blank note on a declared gate down the plain comment, never the repair road", async () => {
    for (const note of ["", "   ", null]) {
      await submitReviewDecisionAction(RUN, `${STEP}#2`, "comment", note);
    }
    expect(p.changes).not.toHaveBeenCalled();
    expect(p.decision).toHaveBeenCalledTimes(3);
    expect(pending().map((g) => g.reviewTaskId)).toEqual([STEP, `${STEP}#2`]);
  });

  // Fold 2 (C3 option B) REVERSES fold 1's case, which sent this note down the
  // repair road: the post's own leg keeps main's plain annotation.
  it("keeps a note on the post's own leg a plain comment and never calls the repair road", async () => {
    const before = structuredClone(gate(`${STEP}#2`));
    const outcome = await submitReviewDecisionAction(RUN, STEP, "comment", "Tighten the intro");

    expect(outcome).toEqual({ kind: "annotated" });
    expect(p.changes).not.toHaveBeenCalled();
    expect(p.decision).toHaveBeenCalledTimes(1);
    expect(p.decision.mock.calls[0][0].decision).toMatchObject({
      runId: RUN, reviewTaskId: STEP, disposition: "comment", comment: "Tighten the intro", reviewedTargets: [POST],
    });
    expect(gate(STEP)).toMatchObject({ status: "pending", disposition: null });
    expect(gate(`${STEP}#2`)).toEqual(before);
  });

  it("keeps a note on the picture's leg a plain comment while the orchestration fence is off", async () => {
    p.fence = false;
    const outcome = await submitReviewDecisionAction(RUN, `${STEP}#2`, "comment", "Make the sky darker");

    expect(outcome).toEqual({ kind: "annotated" });
    expect(p.changes).not.toHaveBeenCalled();
    expect(p.decision).toHaveBeenCalledTimes(1);
    expect(pending().map((g) => g.reviewTaskId)).toEqual([STEP, `${STEP}#2`]);
  });

  it("keeps a note on a declared leg that pins two targets a plain comment", async () => {
    gate(`${STEP}#2`)!.targets = [FEATURED, REGENERATED];
    const outcome = await submitReviewDecisionAction(RUN, `${STEP}#2`, "comment", "Make the sky darker");

    expect(outcome).toEqual({ kind: "annotated" });
    expect(p.changes).not.toHaveBeenCalled();
    expect(p.decision).toHaveBeenCalledTimes(1);
    expect(p.decision.mock.calls[0][0].decision).toMatchObject({ reviewTaskId: `${STEP}#2`, reviewedTargets: [FEATURED, REGENERATED] });
    expect(pending().map((g) => g.reviewTaskId)).toEqual([STEP, `${STEP}#2`]);
  });
});
