/**
 * cinatra#4245 (D2): the review page's decision action on the review step a flow
 * declares itself (`wayflow-<task>`, no `#n` suffix). The prompt window's typed
 * change request (the lent Comment of the run's assistant, which passes
 * `typedChangeRequest`) goes to the change-request road (spec 5.2); the store's
 * answer is mapped to its own outcome. Only the store's not-eligible refusal (one
 * of the cases the issue names: a sibling gate pending, no produced event naming
 * the gate, a producer that cannot repair, ...) falls back to the plain
 * annotation; a pause refusal never does (H1-H3). Red at 3020d014: the action
 * sends the step's own gate straight to the annotation and never asks the store.
 *
 * The decision bar's Comment button stays the non-terminal note of design
 * section VI ("leaves the gate pending - nothing resumes, and the run stays
 * paused"): on the step's own gate it never asks the store (H10). Red at
 * 9c6d09cb: the button's comment took the change-request road too.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const p = vi.hoisted(() => ({
  enforce: vi.fn(), pinned: vi.fn(), decision: vi.fn(), changes: vi.fn(), actor: vi.fn(), fence: true,
}));
vi.mock("@/app/artifacts/[id]/review-gate-ports", () => ({
  enforceReviewDecisionAccess: p.enforce, readReviewGatePinnedTargets: p.pinned,
  submitReviewDecision: p.decision, submitReviewSurfaceChangesRequested: p.changes,
}));
vi.mock("../review-actor", () => ({ resolveReviewActorContext: p.actor }));
vi.mock("@/lib/lifecycle/lifecycle-activation", () => ({ isLifecycleReviewOrchestrationActive: () => p.fence }));

import { submitReviewDecisionAction } from "../actions";

const RUN = "run-4245";
const STEP = "wayflow-task-4245";
const TARGET = { artifactId: "art-post", representationRevisionId: "rev-post-1" };
const actor = { orgId: "org", actor: { userId: "reader" }, roleHints: [] };
const RETRY = { kind: "error", message: "The change request could not be recorded." };
const refuse = (code: string) => ({ ok: false, code, error: code });

beforeEach(() => {
  vi.clearAllMocks();
  p.fence = true;
  p.actor.mockResolvedValue(actor);
  p.enforce.mockResolvedValue({ ok: true });
  p.pinned.mockResolvedValue([TARGET]);
  p.decision.mockResolvedValue({ ok: true, kind: "annotated" });
  p.changes.mockResolvedValue({ ok: true, status: "requested", idempotent: false });
});

/** The prompt window's typed change request: the lent Comment names the road. */
async function commentOnStep(note = "Say it in plain words") {
  return submitReviewDecisionAction(RUN, STEP, "comment", note, undefined, null, null, { typedChangeRequest: true });
}

/** The decision bar's Comment button: the page's bound action passes no road. */
async function pressCommentOnStep(note = "Say it in plain words") {
  return submitReviewDecisionAction(RUN, STEP, "comment", note);
}

describe("a typed change request on the step's own declared gate (cinatra#4245 D2)", () => {
  it("H1 pause-held maps to the retryable error, never to the annotation", async () => {
    p.changes.mockResolvedValue(refuse("pause-held"));
    const outcome = await commentOnStep();
    expect(p.changes).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual(RETRY);
    expect(p.decision).not.toHaveBeenCalled();
  });

  it("H2 pause-moved-on maps to the blocked no-longer-pending outcome, never to the annotation", async () => {
    p.changes.mockResolvedValue(refuse("pause-moved-on"));
    const outcome = await commentOnStep();
    expect(p.changes).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: "blocked", reason: "no-longer-pending" });
    expect(p.decision).not.toHaveBeenCalled();
  });

  it("H3 pause-unverifiable maps to the retryable error, never to the annotation", async () => {
    p.changes.mockResolvedValue(refuse("pause-unverifiable"));
    const outcome = await commentOnStep();
    expect(p.changes).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual(RETRY);
    expect(p.decision).not.toHaveBeenCalled();
  });

  it("H4 an eligible comment is a change request: the store is asked with the step's gate and its one target", async () => {
    const outcome = await commentOnStep("  Say it in plain words  ");
    expect(p.changes).toHaveBeenCalledWith({ runId: RUN, reviewTaskId: STEP, baseTarget: TARGET, feedback: "Say it in plain words", origin: "typed", actorCtx: actor });
    expect(outcome).toEqual({ kind: "changes-requested", status: "requested", idempotent: false });
    expect(p.decision).not.toHaveBeenCalled();
  });

  it("H5 the change request ends the run's pause, so it needs approve access too", async () => {
    await commentOnStep();
    expect(p.enforce).toHaveBeenCalledWith({ runId: RUN, op: "respondToHitl", actorCtx: actor });
    expect(p.enforce).toHaveBeenCalledWith({ runId: RUN, op: "approveHitl", actorCtx: actor });
  });

  it("H6 every other pause refusal maps to its own outcome, never to the annotation", async () => {
    const cases: [string, unknown][] = [
      ["pause-not-pending", { kind: "blocked", reason: "no-longer-pending" }],
      ["pause-gate-mismatch", { kind: "blocked", reason: "no-longer-pending" }],
      ["pause-mode-conflict", RETRY],
      ["pause-not-repairable", RETRY],
      ["declared-gate-not-permitted", expect.objectContaining({ kind: "not-permitted" })],
    ];
    for (const [code, want] of cases) {
      p.changes.mockResolvedValueOnce(refuse(code));
      expect(await commentOnStep()).toEqual(want);
    }
    expect(p.changes).toHaveBeenCalledTimes(cases.length);
    expect(p.decision).not.toHaveBeenCalled();
  });

  it("H7 guard (green at base): the store's not-eligible refusal keeps the plain annotation", async () => {
    p.changes.mockResolvedValue(refuse("declared-gate-not-eligible"));
    const outcome = await commentOnStep();
    expect(outcome).toEqual({ kind: "annotated" });
    expect(p.decision).toHaveBeenCalledTimes(1);
    expect(p.decision.mock.calls[0][0].decision).toMatchObject({ runId: RUN, reviewTaskId: STEP, disposition: "comment", reviewedTargets: [TARGET] });
  });

  it("H8 guard (green at base): a reviewer who may only respond keeps the plain annotation", async () => {
    p.enforce.mockImplementation(async ({ op }: { op: string }) => ({ ok: op === "respondToHitl" }));
    expect(await commentOnStep()).toEqual({ kind: "annotated" });
    expect(p.changes).not.toHaveBeenCalled();
    expect(p.decision).toHaveBeenCalledTimes(1);
  });

  it("H9 guard (green at base): with the fence off, an empty comment, or two targets the comment stays a plain annotation", async () => {
    p.fence = false;
    expect(await commentOnStep()).toEqual({ kind: "annotated" });
    p.fence = true;
    expect(await submitReviewDecisionAction(RUN, STEP, "comment", "   ", undefined, null, null, { typedChangeRequest: true })).toEqual({ kind: "annotated" });
    p.pinned.mockResolvedValue([TARGET, { artifactId: "art-img", representationRevisionId: "rev-img-1" }]);
    expect(await commentOnStep()).toEqual({ kind: "annotated" });
    expect(p.changes).not.toHaveBeenCalled();
    expect(p.decision).toHaveBeenCalledTimes(3);
  });
});

describe("the decision bar's Comment button on the step's own declared gate (design section VI)", () => {
  it("H10 the button's comment is a non-terminal note: the store is never asked and the run stays paused", async () => {
    const outcome = await pressCommentOnStep();
    expect(outcome).toEqual({ kind: "annotated" });
    expect(p.changes).not.toHaveBeenCalled();
    expect(p.enforce).not.toHaveBeenCalledWith({ runId: RUN, op: "approveHitl", actorCtx: actor });
    expect(p.decision).toHaveBeenCalledTimes(1);
    expect(p.decision.mock.calls[0][0].decision).toMatchObject({
      runId: RUN, reviewTaskId: STEP, disposition: "comment", comment: "Say it in plain words", reviewedTargets: [TARGET],
    });
  });

  it("H11 guard (green at base): a picture leg (`#n`) keeps its change request from the conversation's comment (cinatra#3080); the run stays paused there", async () => {
    await submitReviewDecisionAction(RUN, `${STEP}#2`, "conversation-comment", "Make the sky darker");
    expect(p.changes).toHaveBeenCalledTimes(1);
    expect(p.changes.mock.calls[0][0]).toMatchObject({ runId: RUN, reviewTaskId: `${STEP}#2`, baseTarget: TARGET });
    expect(p.enforce).not.toHaveBeenCalledWith({ runId: RUN, op: "approveHitl", actorCtx: actor });
  });
});
