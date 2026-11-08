// THE REVIEW FLOOR ON THE TYPED ROAD (cinatra#3080).
//
// The review card draws Comment · Regenerate · Continue, and there is no Reject.
// The typed road must say the same thing the card says, at every place a WORD
// becomes an authority:
//
//   · what a review LENDS (`controlsLentBy`) and what a grant may NAME
//     (`LENT_ACTION_CONTROLS`): Regenerate in, Reject out, and `approve` kept as
//     the control id behind Continue (the disposition it stores);
//   · what the person's own words put on the MENU (`typed-decision-words.ts`):
//     "continue" names Continue, and Regenerate is always on, because the words
//     ARE the request;
//   · what the SEND does with a Reject: no grant, and the platform's own
//     sentence for the assistant to say back;
//   · what the PRESS does (`handleLentAction`): a Regenerate reaches the one
//     review entry as `regenerate`, with no prompt of its own;
//   · what the person is TOLD: a Continue answers "Continued."

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-review-typed-road";

const frame: { store: Record<string, unknown> | undefined } = { store: undefined };

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

import { issueTurnLentActionGrant, typedControlMenuFor } from "../bound-card-binding";
import { controlsLentBy } from "../bound-reference-resolver";
import {
  LENT_ACTION_CONTROLS,
  isLentActionControl,
  mintLentActionGrant,
  verifyLentActionGrant,
} from "../lent-action-grant";
import { handleLentAction, reviewOutcomeSentence } from "../lent-action-mcp";
import { encodeLifecycleGateRef } from "../lifecycle-card-ref";
import { wordsNameControl } from "../typed-decision-words";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

const PERSON = { userId: "usr_1", orgId: "org_1" };
const RUN = "run_1";
const GATE = "gate_1";
const REF = encodeLifecycleGateRef({ runId: RUN, reviewTaskId: GATE })!;

const ACTOR = {
  actor: { actorType: "human", source: "agent", userId: PERSON.userId, orgId: PERSON.orgId },
  orgId: PERSON.orgId,
  roleHints: { actorOrganizationId: PERSON.orgId },
} as unknown as ReviewActorContext;

const REVIEW = {
  kind: "review" as const,
  runId: RUN,
  reviewTaskId: GATE,
  pinnedTargets: [{ artifactId: "art_1", representationRevisionId: "rev_1" }],
};

/** The platform's own answer to a Reject, word for word. */
const NO_REJECT = "There is no Reject decision. Leave the review open, Comment, or Continue.";

// -------------------------------------------------------------------------
// The SEND: what a message typed beside a bound review is granted.
// -------------------------------------------------------------------------

function sendDeps(over: Record<string, unknown> = {}) {
  return {
    resolveActor: vi.fn(async () => ACTOR),
    resolveBinding: vi.fn(async () => ({
      kind: "bound",
      ref: REF,
      resolution: REVIEW,
      controls: controlsLentBy(REVIEW),
    })),
    mint: vi.fn(mintLentActionGrant),
    record: vi.fn(async () => true),
    sweep: vi.fn(async () => undefined),
    ...over,
  };
}

async function send(messageText: string, d = sendDeps()) {
  return issueTurnLentActionGrant({
    claim: { candidateRefs: [REF], focusedRef: null },
    userId: PERSON.userId,
    orgId: PERSON.orgId,
    messageId: "msg_1",
    messageText,
    deps: d as never,
  });
}

describe("what a review lends on the typed road", () => {
  it("a review lends Comment, Regenerate and Continue and never Reject", () => {
    const lent = controlsLentBy(REVIEW);
    expect(lent).toEqual(["comment", "regenerate", "approve"]);
    expect(lent as readonly string[]).not.toContain("reject");
  });

  it("'continue' names the approve control", () => {
    expect(wordsNameControl("approve", "continue")).toBe(true);
    expect(wordsNameControl("approve", "Continued, thanks")).toBe(true);
    expect(typedControlMenuFor(REVIEW, "continue")).toEqual(["comment", "regenerate", "approve"]);
  });

  it("'approve' still names it", () => {
    expect(wordsNameControl("approve", "approve")).toBe(true);
    expect(typedControlMenuFor(REVIEW, "approve")).toEqual(["comment", "regenerate", "approve"]);
  });

  it("'reject' mints no grant and relays the platform's sentence", async () => {
    const d = sendDeps();
    const out = await send("reject", d);
    expect(out.grant).toBeNull();
    expect(out.systemContext).toContain("word for word");
    expect(out.systemContext).toContain(`"${NO_REJECT}"`);
    expect(out.systemContext).toContain("You hold no authority");
    // NOTHING was minted and NOTHING was recorded: the refusal happens before
    // the menu is built, so no row carries the person's words.
    expect(d.mint).not.toHaveBeenCalled();
    expect(d.record).not.toHaveBeenCalled();
  });

  it("'please make the title shorter' puts regenerate on the menu and the context names regenerate as the road for a change", async () => {
    const d = sendDeps();
    const out = await send("please make the title shorter", d);
    expect(out.grant).toEqual(expect.any(String));
    const claims = verifyLentActionGrant(out.grant!);
    expect(claims?.controls).toEqual(["comment", "regenerate"]);
    // The anchor stays Comment: `primaryControlFor` is unchanged for a review.
    expect(claims?.control).toBe("comment");
    expect(out.systemContext).toContain("This message may press: comment, regenerate");
    // The two roads for words are named apart: a change presses Regenerate, a
    // note that asks for no change presses Comment.
    expect(out.systemContext).toContain("A REQUEST TO CHANGE THE WORK");
    expect(out.systemContext).toContain("presses `regenerate`");
    expect(out.systemContext).toContain("A NOTE THAT ASKS FOR NO CHANGE presses `comment`");
    // The person's own words are the note the Regenerate carries.
    const record = d.record as unknown as { mock: { calls: unknown[][] } };
    expect(record.mock.calls[0]![1]).toBe("please make the title shorter");
  });
});

describe("what a grant may name", () => {
  it("regenerate is a grant control and reject is not", () => {
    expect(LENT_ACTION_CONTROLS).toContain("regenerate");
    expect(LENT_ACTION_CONTROLS as readonly string[]).not.toContain("reject");
    expect(isLentActionControl("regenerate")).toBe(true);
    expect(isLentActionControl("reject")).toBe(false);
    // `approve` stays: it is the control id behind Continue.
    expect(isLentActionControl("approve")).toBe(true);
  });
});

// -------------------------------------------------------------------------
// The PRESS: what the lent action does with a Regenerate.
// -------------------------------------------------------------------------

describe("the press reaches the one review entry", () => {
  const WORDS = "please make the title shorter";
  let submitReviewDecision: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    submitReviewDecision = vi.fn(async () => ({
      kind: "changes-requested",
      status: "requested",
      idempotent: false,
    }));
    frame.store = undefined;
  });

  it("pressing regenerate reaches the one entry as regenerate", async () => {
    const minted = mintLentActionGrant({
      ...PERSON,
      messageId: "msg_regenerate",
      cardRef: REF,
      control: "comment",
      controls: ["comment", "regenerate"],
    });
    expect(minted).not.toBeNull();
    frame.store = { ...PERSON, lentActionGrant: minted!.grant };

    const out = await handleLentAction(
      { ref: REF, control: "regenerate" },
      {
        resolve: vi.fn(async () => REVIEW),
        resolveActor: vi.fn(async () => ACTOR),
        consume: vi.fn(async () => ({ outcome: "consumed" as const, messageText: WORDS })),
        submitReviewDecision,
      } as never,
    );

    expect(submitReviewDecision).toHaveBeenCalledTimes(1);
    // The entry is told `regenerate`, the person's own words are the note, the
    // person's own credential is the actor, there is no suggestion partition,
    // and a typed Regenerate carries NO prompt of its own.
    expect(submitReviewDecision).toHaveBeenCalledWith(
      RUN,
      GATE,
      "regenerate",
      WORDS,
      ACTOR,
      null,
      null,
    );
    expect(out.structuredContent).toMatchObject({ ok: true });
  });

  it("the typed answer for a Continue says Continued", () => {
    expect(
      reviewOutcomeSentence({ kind: "decided", disposition: "approve", idempotent: false }),
    ).toBe("Continued. The gate is resolved and the run has been released to continue.");
    expect(
      reviewOutcomeSentence({ kind: "decided", disposition: "approve", idempotent: true }),
    ).toBe(
      "Continued. The gate is resolved and the run has been released to continue. (This decision had already been recorded.)",
    );
  });
});
