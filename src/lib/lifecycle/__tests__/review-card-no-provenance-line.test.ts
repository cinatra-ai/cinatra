// THE REVIEW CARD CARRIES NO NOTES REGION, AND SO NO PROVENANCE LINE
// (cinatra#3080, fix leg 5).
//
// WHAT THE FIFTH READING FOUND. On the review card in the conversation, between
// the target and the floor, a third region drew an Advisory-comments panel, and
// inside it the Audit lane's own service-authored diagnostic — a bracketed
// `[provenance]` line naming an internal projection digest, an authorization
// verdict and the three projected field paths. None of that is a reviewer's
// note, and none of it is drawn anywhere on this card.
//
// THE DRAWING, IN ITS OWN WORDS. The ratified cards drawing enumerates the
// review card exhaustively: "The review card fills the assistant's turn: the
// target panel naming what is under review and pinning its exact revision, then
// the decision floor that governs it." (§II) Two regions, and no third. Its
// settled and pending readings draw the same two and nothing between them, and
// §IV's four drawn states add no notes region to any of them.
//
// WHERE ADVISORY COMMENTS DO BELONG. The same drawing gives them to a DIFFERENT
// card: the verification card "closes with Advisory comments: a label over one
// panel per comment, each carrying its author kind in mono above the comment
// itself. The reading's provenance is the body of a service comment there, not
// a line of its own." (§VII) That card still draws them, off this same seam, and
// is untouched here.
//
// AND THE FLOOR'S OWN RULE. The review drawing says a display "carries no note
// row of its own … never as a line written into the panel", and three times over
// that no surface here carries a provenance line.
//
// SO IT IS REMOVED AT THE SOURCE. Not filtered by author kind — a user-authored
// note in that region is just as undrawn as a service-authored one. The review
// gate's state stops projecting notes at all, which is what these tests pin:
// the advisory seam is never even read for a review gate, so no diagnostic can
// reach a card by any later route.

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-refs";

const enforceReviewRunAccess = vi.fn();
const readReviewGateState = vi.fn();
const readReviewGate = vi.fn();
const readAdvisoryCommentsForGates = vi.fn(async () => []);

vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  enforceReviewRunAccess: (...args: unknown[]) => enforceReviewRunAccess(...args),
  readReviewGateState: (...args: unknown[]) => readReviewGateState(...args),
  readReviewGate: (...args: unknown[]) => readReviewGate(...args),
  readAdvisoryCommentsForGates: (...args: unknown[]) =>
    readAdvisoryCommentsForGates(...(args as [])),
}));

vi.mock("@cinatra-ai/agents/lifecycle-verification-read-store", () => ({
  readVerificationRecordForGate: vi.fn(async () => null),
}));

import { lifecycleCardStateSchema } from "@cinatra-ai/agent-ui-protocol/renderable-views";

import { encodeLifecycleGateRef, resolveLifecycleCardState } from "../lifecycle-card-refetch";

const actorCtx = {
  actor: { actorType: "human", userId: "u1", source: "route" },
  orgId: "org-1",
  roleHints: { actorOrganizationId: "org-1" },
} as never;

const REF = encodeLifecycleGateRef({ runId: "run-1", reviewTaskId: "task-1" })!;

/**
 * The Audit lane's advisory body, in the exact shape `buildCoreAnalysis`
 * renders it — summary, bullets, then the bracketed diagnostic. This is the
 * literal payload the fifth reading found drawn on the review card.
 */
const AUDIT_DIAGNOSTIC = [
  "Audit of 3 disclosed field(s).",
  "• 3 disclosed field(s) carry content.",
  "[provenance] lane=core-analysis-lane target=art-s4-demo@rev-repaired projection=9f2c1a7b4e60d3a8 authz=allowed fields=[form,resource,revision] excluded=[]",
].join("\n");

/** A genuine reviewer note, to prove the region goes whoever wrote in it. */
const TYPED = "The second section needs a plainer opening sentence.";

function accessFor(granted: string[]) {
  enforceReviewRunAccess.mockImplementation(async (_runId, _actor, op) => ({
    ok: granted.includes(op as string),
  }));
}

const resolve = () =>
  resolveLifecycleCardState({ viewType: "artifact_review_gate", ref: REF, actorCtx });

beforeEach(() => {
  vi.clearAllMocks();
  readAdvisoryCommentsForGates.mockReset();
  readAdvisoryCommentsForGates.mockResolvedValue([
    { authorKind: "service", body: AUDIT_DIAGNOSTIC },
    { authorKind: "user", body: TYPED },
  ] as never);
  readReviewGate.mockReset();
  readReviewGate.mockResolvedValue({ id: "gate-1" } as never);
});

describe("the review gate's state carries no notes region", () => {
  it("draws no notes on a PENDING gate, and no diagnostic reaches the wire", async () => {
    accessFor(["read", "approveHitl", "respondToHitl"]);
    readReviewGateState.mockResolvedValue({ status: "pending", targets: [] } as never);

    const env = await resolve();
    expect(env.state).toMatchObject({ state: "pending", canDecide: true });
    expect((env.state as { notes?: unknown }).notes).toBeUndefined();
    expect(JSON.stringify(env.state)).not.toContain("[provenance]");
    expect(JSON.stringify(env.state)).not.toContain("core-analysis-lane");
    expect(lifecycleCardStateSchema.safeParse(env.state).success).toBe(true);
  });

  it("draws none on a RESTRICTED gate either", async () => {
    accessFor(["read", "respondToHitl"]);
    readReviewGateState.mockResolvedValue({ status: "pending", targets: [] } as never);

    const env = await resolve();
    expect(env.state).toMatchObject({ state: "restricted", canDecide: false });
    expect((env.state as { notes?: unknown }).notes).toBeUndefined();
    expect(JSON.stringify(env.state)).not.toContain("[provenance]");
  });

  it("draws none on the SETTLED reading", async () => {
    accessFor(["read"]);
    readReviewGateState.mockResolvedValue({ status: "resolved" } as never);

    const env = await resolve();
    expect(env.state).toMatchObject({ state: "settled" });
    expect((env.state as { notes?: unknown }).notes).toBeUndefined();
    expect(JSON.stringify(env.state)).not.toContain("[provenance]");
  });

  it("never reads the advisory seam for a review gate at all — removed at the source", async () => {
    // The narrow fix would have filtered the service row out of a list this
    // resolver still built. The region is not drawn at all, so the list is not
    // built at all, and no later reader can put a diagnostic back on the card.
    accessFor(["read", "approveHitl", "respondToHitl"]);
    readReviewGateState.mockResolvedValue({ status: "pending", targets: [] } as never);

    await resolve();
    expect(readAdvisoryCommentsForGates).not.toHaveBeenCalled();
  });

  it("keeps a reviewer's own words off the card too — the region goes, not one author kind", async () => {
    accessFor(["read", "approveHitl", "respondToHitl"]);
    readReviewGateState.mockResolvedValue({ status: "pending", targets: [] } as never);
    readAdvisoryCommentsForGates.mockResolvedValue([
      { authorKind: "user", body: TYPED },
    ] as never);

    const env = await resolve();
    expect(JSON.stringify(env.state)).not.toContain(TYPED);
  });
});
