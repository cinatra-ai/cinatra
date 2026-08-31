// THE RECORDED NOTE REACHES THE READER (cinatra#3080).
//
// `Comment` is the floor's non-terminal act: it records the reviewer's words
// against the review and leaves the gate pending. The words were being written
// — one advisory-comment row, one audit row, in one transaction — and then
// shown to nobody: after the press the typed sentence appeared zero times in
// the page text of the run page, the review page and the conversation, and no
// panel, line or toast said it had been recorded. A note a reader cannot read
// back is a note the product only claims to have taken.
//
// WHERE IT IS DRAWN. The ratified cards drawing fixes ONE shape for the
// comments hanging off a gate (§VII): "Advisory comments: a label over one
// panel per comment, each carrying its author kind in mono above the comment
// itself." That is the shape the verification card already draws, off the SAME
// `gate_advisory_comments` seam, and it is reused here rather than invented
// again — the review's own recorded notes are read back in the drawing's own
// panel.
//
// WHY IT TRAVELS ON THE STATE. The review card carries no body (its target
// arrives through the island), and the ONE renderer draws on four hosts — a
// chat transcript has nobody to pass notes down from. So the notes ride the
// authorized state, behind the run READ check the resolver has already cleared,
// exactly as `suggestions` do.

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

import {
  LIFECYCLE_MAX_REVIEW_NOTES,
  lifecycleCardStateSchema,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

import { encodeLifecycleGateRef, resolveLifecycleCardState } from "../lifecycle-card-refetch";

const actorCtx = {
  actor: { actorType: "human", userId: "u1", source: "route" },
  orgId: "org-1",
  roleHints: { actorOrganizationId: "org-1" },
} as never;

const REF = encodeLifecycleGateRef({ runId: "run-1", reviewTaskId: "task-1" })!;

/** The exact sentence the capture typed into the floor's note field. */
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
  readAdvisoryCommentsForGates.mockResolvedValue([] as never);
  readReviewGate.mockReset();
  readReviewGate.mockResolvedValue({ id: "gate-1" } as never);
});

describe("a recorded note travels on the review card's authorized state", () => {
  it("carries the reviewer's own words on a PENDING gate", async () => {
    accessFor(["read", "approveHitl", "respondToHitl"]);
    readReviewGateState.mockResolvedValue({ status: "pending", targets: [] } as never);
    readAdvisoryCommentsForGates.mockResolvedValue([
      { authorKind: "user", body: TYPED },
    ] as never);

    const env = await resolve();
    expect(env.state).toMatchObject({
      state: "pending",
      notes: [{ authorKind: "user", body: TYPED }],
    });
    expect(lifecycleCardStateSchema.safeParse(env.state).success).toBe(true);
  });

  it("carries them on a RESTRICTED gate too — a reader who may not decide still reads the review", async () => {
    accessFor(["read", "respondToHitl"]);
    readReviewGateState.mockResolvedValue({ status: "pending", targets: [] } as never);
    readAdvisoryCommentsForGates.mockResolvedValue([
      { authorKind: "user", body: TYPED },
    ] as never);

    const env = await resolve();
    expect(env.state).toMatchObject({
      state: "restricted",
      notes: [{ authorKind: "user", body: TYPED }],
    });
  });

  it("keeps them on the SETTLED reading — the exchange stays with the decision", async () => {
    accessFor(["read"]);
    readReviewGateState.mockResolvedValue({ status: "resolved" } as never);
    readAdvisoryCommentsForGates.mockResolvedValue([
      { authorKind: "user", body: TYPED },
    ] as never);

    const env = await resolve();
    expect(env.state).toMatchObject({
      state: "settled",
      notes: [{ authorKind: "user", body: TYPED }],
    });
  });

  it("reads the gate the reader already cleared, and nothing else", async () => {
    accessFor(["read", "approveHitl", "respondToHitl"]);
    readReviewGateState.mockResolvedValue({ status: "pending", targets: [] } as never);
    await resolve();
    expect(readAdvisoryCommentsForGates).toHaveBeenCalledWith(["gate-1"]);
  });

  it("says NOTHING to a reader who cannot read the run", async () => {
    accessFor([]);
    readAdvisoryCommentsForGates.mockResolvedValue([
      { authorKind: "user", body: TYPED },
    ] as never);
    const env = await resolve();
    expect(env.state).toEqual({ state: "absent" });
    expect(readAdvisoryCommentsForGates).not.toHaveBeenCalled();
  });
});

describe("the panel is honest about what it could not read", () => {
  it("omits the field entirely when the comment store fails — never an empty list", async () => {
    // An empty list is a STATEMENT ("this review carries no notes"). Making it
    // after a store failure asserts an absence nobody established, so the field
    // is left off and the card draws no panel at all.
    accessFor(["read", "approveHitl", "respondToHitl"]);
    readReviewGateState.mockResolvedValue({ status: "pending", targets: [] } as never);
    readAdvisoryCommentsForGates.mockRejectedValue(new Error("store down") as never);

    const env = await resolve();
    expect(env.state).toMatchObject({ state: "pending", canDecide: true });
    expect((env.state as { notes?: unknown }).notes).toBeUndefined();
  });

  it("survives a SYNCHRONOUS throw from the store the same way", async () => {
    accessFor(["read", "approveHitl", "respondToHitl"]);
    readReviewGateState.mockResolvedValue({ status: "pending", targets: [] } as never);
    readAdvisoryCommentsForGates.mockImplementation(() => {
      throw new Error("not a function on this build");
    });

    const env = await resolve();
    expect(env.state).toMatchObject({ state: "pending" });
    expect((env.state as { notes?: unknown }).notes).toBeUndefined();
  });

  it("drops a half-written row rather than drawing it blank", async () => {
    accessFor(["read", "approveHitl", "respondToHitl"]);
    readReviewGateState.mockResolvedValue({ status: "pending", targets: [] } as never);
    readAdvisoryCommentsForGates.mockResolvedValue([
      { authorKind: "", body: TYPED },
      { authorKind: "user", body: "" },
      { authorKind: "user", body: TYPED },
    ] as never);

    const env = await resolve();
    expect((env.state as { notes: unknown[] }).notes).toEqual([
      { authorKind: "user", body: TYPED },
    ]);
  });

  it("clamps a pathological gate to the wire ceiling", async () => {
    accessFor(["read", "approveHitl", "respondToHitl"]);
    readReviewGateState.mockResolvedValue({ status: "pending", targets: [] } as never);
    readAdvisoryCommentsForGates.mockResolvedValue(
      Array.from({ length: LIFECYCLE_MAX_REVIEW_NOTES + 7 }, (_, i) => ({
        authorKind: "user",
        body: `note ${i}`,
      })) as never,
    );

    const env = await resolve();
    const notes = (env.state as { notes: unknown[] }).notes;
    expect(notes).toHaveLength(LIFECYCLE_MAX_REVIEW_NOTES);
    expect(lifecycleCardStateSchema.safeParse(env.state).success).toBe(true);
  });

  it("keeps the LATEST notes when it has to choose — the newest words are the live ones", async () => {
    accessFor(["read", "approveHitl", "respondToHitl"]);
    readReviewGateState.mockResolvedValue({ status: "pending", targets: [] } as never);
    readAdvisoryCommentsForGates.mockResolvedValue(
      Array.from({ length: LIFECYCLE_MAX_REVIEW_NOTES + 2 }, (_, i) => ({
        authorKind: "user",
        body: `note ${i}`,
      })) as never,
    );

    const env = await resolve();
    const notes = (env.state as { notes: { body: string }[] }).notes;
    // Store order is oldest-first, so the tail is what survives, still in order.
    expect(notes[notes.length - 1]!.body).toBe(`note ${LIFECYCLE_MAX_REVIEW_NOTES + 1}`);
    expect(notes[0]!.body).toBe("note 2");
  });
});
