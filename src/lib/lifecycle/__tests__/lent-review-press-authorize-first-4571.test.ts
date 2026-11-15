// A LENT REVIEW PRESS IS AUTHORIZED BEFORE ITS GRANT IS SPENT (cinatra#3080,
// pre-review 1 of #4571, finding 1).
//
// The grant a typed message carries is single-use. The spend (gate 6) is
// irreversible, so every refusal the press can know before it acts must come
// BEFORE the spend:
//   - the run-access right the pressed control needs (Continue and Regenerate
//     settle the gate -> approveHitl; Comment -> respondToHitl). A read/respond-
//     only reviewer whose menu carries Regenerate is refused with the grant
//     intact, and can still press Comment with the same grant;
//   - a Regenerate the review cannot take: the review-orchestration fence off,
//     a gate that is not an automatic lifecycle gate, a batch gate, or a gate
//     that pins more than one target.
//
// The DEFAULT preflight is under test here: nothing replaces it. The run-access
// port and the fence are mocked at their own modules, the same seams the review
// action's own tests use.

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lent-review-authorize-first";

const frame: { store: Record<string, unknown> | undefined } = { store: undefined };
const p = vi.hoisted(() => ({
  fence: true,
  // The rights this reviewer holds on the run.
  rights: new Set<string>(["approveHitl", "respondToHitl"]),
  access: [] as string[],
}));

vi.mock("@cinatra-ai/mcp-server", () => ({
  mcpRequestContextStorage: { getStore: () => frame.store },
}));
vi.mock("@cinatra-ai/agents/review-task-actions", () => ({
  approveReviewTaskInternal: vi.fn(),
}));
vi.mock(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/actions",
  () => ({ submitReviewDecisionAction: vi.fn() }),
);
vi.mock("@/app/artifacts/[id]/review-gate-ports", () => ({
  enforceReviewDecisionAccess: vi.fn(async ({ op }: { op: string }) => {
    p.access.push(op);
    return p.rights.has(op) ? { ok: true } : { ok: false, status: 403 };
  }),
}));
vi.mock("@/lib/lifecycle/lifecycle-activation", () => ({
  isLifecycleReviewOrchestrationActive: () => p.fence,
}));
vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  enforceReviewRunAccess: vi.fn(),
  readGatePinnedTargets: vi.fn(),
}));
vi.mock("@cinatra-ai/agents/lifecycle-policy-store", () => ({
  listOpenReviewGateCandidates: vi.fn(async () => []),
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  readLatestDurableHitlGateArtifact: vi.fn(),
}));
vi.mock("@cinatra-ai/agents/db", () => ({ agentBuilderPool: { query: vi.fn() } }));

import { mintLentActionGrant } from "../lent-action-grant";
import { handleLentAction } from "../lent-action-mcp";
import { encodeLifecycleGateRef } from "../lifecycle-card-ref";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

const PERSON = { userId: "usr_1", orgId: "org_1" };
const RUN = "run_1";
const AUTO_GATE = "lifecycle-review:evt_1";
const WORDS = "Please change the crop";

const ACTOR = {
  actor: { actorType: "human", source: "agent", userId: PERSON.userId, orgId: PERSON.orgId },
  orgId: PERSON.orgId,
  roleHints: { actorOrganizationId: PERSON.orgId },
} as unknown as ReviewActorContext;

const ONE = [{ artifactId: "art_1", representationRevisionId: "rev_1" }];
const TWO = [...ONE, { artifactId: "art_2", representationRevisionId: "rev_2" }];

let spent: Set<string>;
let consume: ReturnType<typeof vi.fn>;
let submitReviewDecision: ReturnType<typeof vi.fn>;

beforeEach(() => {
  p.fence = true;
  p.rights = new Set(["approveHitl", "respondToHitl"]);
  p.access = [];
  spent = new Set();
  consume = vi.fn(async ({ jti }: { jti: string }) => {
    if (spent.has(jti)) return { outcome: "refused" as const };
    spent.add(jti);
    return { outcome: "consumed" as const, messageText: WORDS };
  });
  submitReviewDecision = vi.fn(async (_r: string, _g: string, d: string) =>
    d === "regenerate"
      ? { kind: "changes-requested", status: "requested", idempotent: false }
      : d === "approve"
        ? { kind: "decided", disposition: "approve", idempotent: false }
        : { kind: "annotated" },
  );
  frame.store = undefined;
});

function review(reviewTaskId: string, pinnedTargets = ONE) {
  return { kind: "review" as const, runId: RUN, reviewTaskId, pinnedTargets };
}

/** Bind a grant for this review whose menu holds Comment, Regenerate and Continue. */
function bindGrant(reviewTaskId: string) {
  const ref = encodeLifecycleGateRef({ runId: RUN, reviewTaskId })!;
  const minted = mintLentActionGrant({
    ...PERSON,
    messageId: "msg_1",
    cardRef: ref,
    control: "comment",
    controls: ["comment", "regenerate", "approve"],
  });
  if (!minted) throw new Error("mint failed");
  frame.store = { ...PERSON, lentActionGrant: minted.grant };
  return ref;
}

async function press(control: string, bound: ReturnType<typeof review>) {
  return pressBound(bindGrant(bound.reviewTaskId), control, bound);
}

/** Press `control` on `ref`, with the grant bound to that ref already on the frame. */
async function pressBound(ref: string, control: string, bound: ReturnType<typeof review>) {
  return handleLentAction(
    { ref, control },
    {
      resolve: vi.fn(async () => bound),
      resolveActor: vi.fn(async () => ACTOR),
      consume,
      submitReviewDecision,
    } as never,
  );
}

describe("a lent review press is authorized before its grant is spent (#4571 pre-1 finding 1)", () => {
  it("a respond-only reviewer's Regenerate is refused WITHOUT spending the grant, and Comment then works with the same grant", async () => {
    p.rights = new Set(["respondToHitl"]);
    const bound = review(AUTO_GATE);
    // ONE message: one grant on the frame, bound to one card ref, and both
    // presses below name that same ref. (A ref is sealed with a fresh IV on
    // every encode, so encoding it again would name another card string, which
    // gate 3 refuses whatever the grant.)
    const ref = bindGrant(bound.reviewTaskId);

    const denied = await pressBound(ref, "regenerate", bound);
    expect(denied.structuredContent).toMatchObject({ ok: false, outcome: { kind: "not-permitted" } });
    expect(p.access).toEqual(["approveHitl"]);
    expect(consume).not.toHaveBeenCalled();
    expect(submitReviewDecision).not.toHaveBeenCalled();

    // The same message's grant is still whole: Comment needs respondToHitl only.
    const comment = await pressBound(ref, "comment", bound);
    expect(comment.structuredContent).toMatchObject({ ok: true });
    expect(consume).toHaveBeenCalledTimes(1);
    expect(submitReviewDecision).toHaveBeenCalledWith(RUN, AUTO_GATE, "comment", WORDS, ACTOR, null, null);
  });

  it("a respond-only reviewer's Continue is refused without spending the grant", async () => {
    p.rights = new Set(["respondToHitl"]);
    const out = await press("approve", review(AUTO_GATE));
    expect(out.structuredContent).toMatchObject({ ok: false, outcome: { kind: "not-permitted" } });
    expect(consume).not.toHaveBeenCalled();
    expect(submitReviewDecision).not.toHaveBeenCalled();
  });

  it("a reviewer with no respond right is refused a Comment without spending the grant", async () => {
    p.rights = new Set();
    const out = await press("comment", review(AUTO_GATE));
    expect(out.structuredContent).toMatchObject({ ok: false, outcome: { kind: "not-permitted" } });
    expect(p.access).toEqual(["respondToHitl"]);
    expect(consume).not.toHaveBeenCalled();
  });

  it.each([
    ["a batch gate", () => review("lifecycle-review:batch:part_1")],
    ["a gate that is not an automatic lifecycle gate", () => review("wayflow-task-7")],
    ["a gate that pins more than one target", () => review(AUTO_GATE, TWO)],
  ])("Regenerate on %s is refused before any spend", async (_name, make) => {
    const out = await press("regenerate", make());
    expect(out.structuredContent).toMatchObject({ ok: false, outcome: { kind: "error" } });
    expect(consume).not.toHaveBeenCalled();
    expect(submitReviewDecision).not.toHaveBeenCalled();
  });

  it("Regenerate with the review-orchestration fence off is refused before any spend", async () => {
    p.fence = false;
    const out = await press("regenerate", review(AUTO_GATE));
    expect(out.structuredContent).toMatchObject({ ok: false, outcome: { kind: "error" } });
    expect(consume).not.toHaveBeenCalled();
    expect(submitReviewDecision).not.toHaveBeenCalled();
  });

  it("Comment and Continue on a multi-target or batch gate still spend and reach the entry", async () => {
    const out = await press("approve", review("lifecycle-review:batch:part_1", TWO));
    expect(out.structuredContent).toMatchObject({ ok: true });
    expect(consume).toHaveBeenCalledTimes(1);
    expect(submitReviewDecision).toHaveBeenCalledTimes(1);
  });

  it("an eligible Regenerate by a reviewer with the decision right spends once and reaches the entry", async () => {
    const out = await press("regenerate", review(AUTO_GATE));
    expect(out.structuredContent).toMatchObject({ ok: true });
    expect(p.access).toEqual(["approveHitl"]);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(submitReviewDecision).toHaveBeenCalledWith(RUN, AUTO_GATE, "regenerate", WORDS, ACTOR, null, null);
  });
});
