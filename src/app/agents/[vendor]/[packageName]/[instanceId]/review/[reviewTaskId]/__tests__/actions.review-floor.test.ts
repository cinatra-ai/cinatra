/**
 * THE ONE DECISION ENTRY, SPLIT (cinatra#3080, epic #3023).
 *
 * `submitReviewDecisionAction` is the single non-page-bound entry every review
 * surface funnels through, so this is where acceptance items 3 and 4 are decided
 * against each other:
 *
 *   item 3 — Comment records the note and changes NOTHING else;
 *   item 4 — Regenerate is the ONLY thing that calls the change road's canonical
 *            operation, and it needs the right a terminal decision needs.
 *
 * BEFORE THIS SLICE THOSE TWO WERE ONE PATH. A non-empty Comment on a
 * single-target lifecycle gate was routed into `changes_requested` — the gate
 * closed and a repair opened, from the affordance that is supposed to decide
 * nothing. Adding a Regenerate button beside that would have left two ways to
 * mutate through Comment, so the overload is REMOVED here and the canonical
 * operation is reachable from exactly one action.
 *
 * Unit level: every port is a spy, so what is proven is which road each action
 * takes, in what order, under which access. The four real-store invariants are
 * proven against a real Postgres in
 * `src/app/artifacts/[id]/__tests__/review-floor.integration.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  REVIEW_REJECT_RETIRED_REASON,
  REGENERATE_NEEDS_A_NOTE,
  REGENERATE_MULTI_TARGET_REASON,
  REGENERATE_NOT_ON_THIS_REVIEW,
} from "@/lib/artifacts/review-surface-model";

const ONE_TARGET = [{ artifactId: "art_1", representationRevisionId: "rev_1" }];
const TWO_TARGETS = [
  { artifactId: "art_1", representationRevisionId: "rev_1" },
  { artifactId: "art_2", representationRevisionId: "rev_2" },
];

type Target = { artifactId: string; representationRevisionId: string };
type DecisionArgs = { decision: { disposition: string }; actorCtx: unknown };
type ChangeArgs = {
  runId: string;
  reviewTaskId: string;
  baseTarget: Target;
  feedback: string;
  prompt?: string | null;
};
type AccessArgs = { runId: string; op: string; actorCtx: unknown };

const submitReviewDecision = vi.fn(async (_a: DecisionArgs) => ({
  ok: true,
  idempotent: false,
  fingerprint: "fp",
  plan: null,
}));
const submitReviewSurfaceChangesRequested = vi.fn(async (_a: ChangeArgs) => ({
  ok: true as const,
  repairId: "rep_1",
  route: { kind: "producer_repair" as const },
  attempt: 1,
  status: "requested" as const,
  idempotent: false,
}));
const readReviewGatePinnedTargets = vi.fn(async (_run: string, _task: string) => ONE_TARGET as Target[] | null);
const enforceReviewDecisionAccess = vi.fn(async (_a: AccessArgs) => ({ ok: true }) as { ok: boolean; status?: number });

/** The one argument a spy was called with, narrowed for the assertions below. */
function firstArg<T>(fn: { mock: { calls: unknown[][] } }): T {
  const call = fn.mock.calls[0];
  if (!call) throw new Error("the action called nothing");
  return call[0] as T;
}

vi.mock("@/app/artifacts/[id]/review-gate-ports", () => ({
  submitReviewDecision: (a: DecisionArgs) => submitReviewDecision(a),
  submitReviewSurfaceChangesRequested: (a: ChangeArgs) => submitReviewSurfaceChangesRequested(a),
  readReviewGatePinnedTargets: (run: string, task: string) => readReviewGatePinnedTargets(run, task),
  enforceReviewDecisionAccess: (a: AccessArgs) => enforceReviewDecisionAccess(a),
}));

const isLifecycleReviewOrchestrationActive = vi.fn(() => true);
vi.mock("@/lib/lifecycle/lifecycle-activation", () => ({
  isLifecycleReviewOrchestrationActive: () => isLifecycleReviewOrchestrationActive(),
}));

vi.mock("../review-actor", () => ({
  resolveReviewActorContext: async () => ({
    actor: { actorType: "human", userId: "user_1", source: "route" },
    orgId: "org_1",
    roleHints: undefined,
  }),
}));

const { submitReviewDecisionAction } = await import("../actions");

/** A LIFECYCLE auto review gate id — the shape the change road recognises. */
const AUTO_GATE = "lifecycle-review:art_1:rev_1:artifact_produced";
/** A gate the lifecycle road never opened (a WayFlow review task). */
const PLAIN_GATE = "wayflow-task-1";

beforeEach(() => {
  vi.clearAllMocks();
  isLifecycleReviewOrchestrationActive.mockReturnValue(true);
  readReviewGatePinnedTargets.mockResolvedValue(ONE_TARGET);
  enforceReviewDecisionAccess.mockResolvedValue({ ok: true });
});

describe("acceptance item 3 — Comment records the note and changes nothing else", () => {
  it("takes the plain annotation road even on a single-target LIFECYCLE gate", async () => {
    const outcome = await submitReviewDecisionAction("run_1", AUTO_GATE, "comment", "please tighten the intro");
    expect(outcome).toEqual({ kind: "annotated" });
    // THE OVERLOAD IS GONE: the canonical change operation is not called by a comment.
    expect(submitReviewSurfaceChangesRequested).not.toHaveBeenCalled();
    expect(submitReviewDecision).toHaveBeenCalledTimes(1);
    expect(firstArg<DecisionArgs>(submitReviewDecision).decision.disposition).toBe("comment");
  });

  it("keeps the reader's right it has today (respond, not approve)", async () => {
    await submitReviewDecisionAction("run_1", AUTO_GATE, "comment", "a note");
    expect(firstArg<AccessArgs>(enforceReviewDecisionAccess).op).toBe("respondToHitl");
  });
});

describe("acceptance item 2 — Continue is the former approve, and reject is refused", () => {
  it("Continue submits the stored disposition `approve` (no migration)", async () => {
    const outcome = await submitReviewDecisionAction("run_1", AUTO_GATE, "continue", null);
    expect(outcome).toEqual({ kind: "decided", disposition: "approve", idempotent: false });
    expect(firstArg<DecisionArgs>(submitReviewDecision).decision.disposition).toBe("approve");
  });

  it("`approve` still works, as the compatibility alias it now is", async () => {
    await submitReviewDecisionAction("run_1", AUTO_GATE, "approve", null);
    expect(firstArg<DecisionArgs>(submitReviewDecision).decision.disposition).toBe("approve");
  });

  it("`reject` settles nothing and answers with the stated reason", async () => {
    const outcome = await submitReviewDecisionAction("run_1", AUTO_GATE, "reject", "no");
    expect(outcome).toEqual({ kind: "error", message: REVIEW_REJECT_RETIRED_REASON });
    expect(submitReviewDecision).not.toHaveBeenCalled();
    expect(submitReviewSurfaceChangesRequested).not.toHaveBeenCalled();
    expect(enforceReviewDecisionAccess).not.toHaveBeenCalled();
  });
});

describe("acceptance item 4 — Regenerate rides the change road's canonical operation", () => {
  it("calls the SAME operation the typed changes-requested road calls, and no other", async () => {
    const outcome = await submitReviewDecisionAction("run_1", AUTO_GATE, "regenerate", "make the sky bluer");
    expect(outcome).toEqual({ kind: "changes-requested", status: "requested", idempotent: false });
    expect(submitReviewSurfaceChangesRequested).toHaveBeenCalledTimes(1);
    expect(submitReviewDecision).not.toHaveBeenCalled();
    const call = firstArg<ChangeArgs>(submitReviewSurfaceChangesRequested);
    expect(call.runId).toBe("run_1");
    expect(call.reviewTaskId).toBe(AUTO_GATE);
    expect(call.baseTarget).toEqual(ONE_TARGET[0]);
    expect(call.feedback).toBe("make the sky bluer");
  });

  it("needs the same right a terminal decision needs", async () => {
    await submitReviewDecisionAction("run_1", AUTO_GATE, "regenerate", "again please");
    expect(firstArg<AccessArgs>(enforceReviewDecisionAccess).op).toBe("approveHitl");
  });

  it("refuses a reviewer who may respond but not decide", async () => {
    enforceReviewDecisionAccess.mockResolvedValue({ ok: false, status: 403 });
    const outcome = await submitReviewDecisionAction("run_1", AUTO_GATE, "regenerate", "again please");
    expect(outcome.kind).toBe("not-permitted");
    expect(submitReviewSurfaceChangesRequested).not.toHaveBeenCalled();
  });

  it("refuses an EMPTY note with a reason, before any store is touched", async () => {
    for (const note of [null, "", "   "]) {
      vi.clearAllMocks();
      const outcome = await submitReviewDecisionAction("run_1", AUTO_GATE, "regenerate", note);
      expect(outcome).toEqual({ kind: "error", message: REGENERATE_NEEDS_A_NOTE });
      expect(submitReviewSurfaceChangesRequested).not.toHaveBeenCalled();
      expect(readReviewGatePinnedTargets).not.toHaveBeenCalled();
    }
  });

  it("refuses a legacy MULTI-TARGET gate with a stated reason — and Comment and Continue still work", async () => {
    readReviewGatePinnedTargets.mockResolvedValue(TWO_TARGETS);

    const regenerated = await submitReviewDecisionAction("run_1", AUTO_GATE, "regenerate", "again");
    expect(regenerated).toEqual({ kind: "error", message: REGENERATE_MULTI_TARGET_REASON });
    expect(submitReviewSurfaceChangesRequested).not.toHaveBeenCalled();

    expect(await submitReviewDecisionAction("run_1", AUTO_GATE, "comment", "a note")).toEqual({
      kind: "annotated",
    });
    expect(await submitReviewDecisionAction("run_1", AUTO_GATE, "continue", null)).toEqual({
      kind: "decided",
      disposition: "approve",
      idempotent: false,
    });
  });

  it("refuses a review with no producing step behind it, with a stated reason", async () => {
    const outcome = await submitReviewDecisionAction("run_1", PLAIN_GATE, "regenerate", "again");
    expect(outcome).toEqual({ kind: "error", message: REGENERATE_NOT_ON_THIS_REVIEW });
    expect(submitReviewSurfaceChangesRequested).not.toHaveBeenCalled();
  });

  it("a gate that moved under the reviewer is a BLOCK, never a silent success", async () => {
    readReviewGatePinnedTargets.mockResolvedValue(null);
    const outcome = await submitReviewDecisionAction("run_1", AUTO_GATE, "regenerate", "again");
    expect(outcome).toEqual({ kind: "blocked", reason: "no-longer-pending" });
  });
});

describe("acceptance item 5 — the note and the picture's prompt travel as separate values", () => {
  it("carries the edited prompt beside the note, never folded into it", async () => {
    await submitReviewDecisionAction(
      "run_1",
      AUTO_GATE,
      "regenerate",
      "warmer light",
      undefined,
      null,
      "a red bicycle at golden hour",
    );
    const call = firstArg<ChangeArgs>(submitReviewSurfaceChangesRequested);
    expect(call.feedback).toBe("warmer light");
    expect(call.prompt).toBe("a red bicycle at golden hour");
  });

  it("carries no prompt at all when the reviewed revision is not a picture", async () => {
    await submitReviewDecisionAction("run_1", AUTO_GATE, "regenerate", "warmer light");
    const call = firstArg<ChangeArgs>(submitReviewSurfaceChangesRequested);
    expect(call.feedback).toBe("warmer light");
    expect(call.prompt ?? null).toBeNull();
  });
});
