// THE PROMPT WINDOW ACTS ON THE ACTIVE CARD (cinatra#2853) — acceptance items
// 1, 2, 3 and 4, at the BINDING and the MINT.
//
// Plan (A) §2.2: "For the active card, the signed-in person can state in words
// any action that card already offers, under the same authorization … with a
// review card, 'add a comment: …' or 'approve it'; with a skills card, 'drop the
// research skill and confirm'; with a schedule card, 'make it 8 in the morning
// on weekdays and confirm'."
//
// Plan (A) §2.2, again: "'Active' means the card bound to or explicitly picked
// for the input — with several cards eligible, nothing is guessed (the 2.1
// rules)."

import { describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-typed-actions";

vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  enforceReviewRunAccess: vi.fn(),
  readGatePinnedTargets: vi.fn(),
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  readLatestDurableHitlGateArtifact: vi.fn(),
}));
vi.mock("@cinatra-ai/agents/lifecycle-policy-store", () => ({
  listOpenReviewGateCandidates: vi.fn(async () => []),
}));

import {
  issueTurnLentActionGrant,
  resolveBoundCard,
  severalCardsWaitingRefusal,
  typedControlMenuFor,
} from "../bound-card-binding";
import { controlsLentBy } from "../bound-reference-resolver";
import { verifyLentActionGrant } from "../lent-action-grant";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

const ACTOR = { actor: { userId: "u" }, orgId: "o", roleHints: {} } as unknown as ReviewActorContext;
const countsOne = async () => ({ count: 1, complete: true });

const review = { kind: "review", runId: "run-r", reviewTaskId: "gate-r", pinnedTargets: [] } as const;
const hold = {
  kind: "recommendation_hold",
  runId: "run-h",
  holdRef: "hold-ref",
  agentPackageName: "pkg",
  offered: [
    { skillId: "sk_research", name: "Research" },
    { skillId: "sk_style", name: "House style" },
  ],
} as const;
const proposal = {
  kind: "schedule_proposal",
  ref: "prop-ref",
  runId: null,
  summary: "every weekday at 09:00",
  expired: false,
} as const;
const absent = { kind: "absent" } as const;

function resolverOver(readable: Record<string, unknown>) {
  return vi.fn(async ({ ref }: { ref: string }) => readable[ref] ?? absent) as never;
}

// -------------------------------------------------------------------------
// Acceptance item 3 — the deterministic pick covers EVERY card kind.
// -------------------------------------------------------------------------

describe("the deterministic binding covers all lifecycle card kinds", () => {
  it("a lone skills card binds on its own and reports what it lends", async () => {
    const out = await resolveBoundCard({
      claim: { candidateRefs: ["h"], focusedRef: null },
      actorCtx: ACTOR,
      countOpenCards: countsOne,
      resolve: resolverOver({ h: hold }),
    });
    expect(out).toMatchObject({ kind: "bound", ref: "h" });
    expect((out as unknown as { controls: string[] }).controls).toEqual(["confirm", "skip"]);
  });

  it("a lone schedule card binds on its own and reports what it lends", async () => {
    const out = await resolveBoundCard({
      claim: { candidateRefs: ["s"], focusedRef: null },
      actorCtx: ACTOR,
      countOpenCards: countsOne,
      resolve: resolverOver({ s: proposal }),
    });
    expect(out).toMatchObject({ kind: "bound", ref: "s" });
    expect((out as unknown as { controls: string[] }).controls).toEqual(["adjust", "confirm"]);
  });

  it("a review, a skills card and a schedule card all open and none picked routes NOTHING", async () => {
    const out = await resolveBoundCard({
      claim: { candidateRefs: ["r", "h", "s"], focusedRef: null },
      actorCtx: ACTOR,
      countOpenCards: countsOne,
      resolve: resolverOver({ r: review, h: hold, s: proposal }),
    });
    expect(out).toEqual({
      kind: "ambiguous",
      count: 3,
      refusal: severalCardsWaitingRefusal(3),
    });
    // The refusal names the way out and no identifier of any card.
    expect(severalCardsWaitingRefusal(3)).toContain("Choose the one you mean");
    expect(severalCardsWaitingRefusal(3)).not.toContain("run-");
  });

  it("an explicit pick of the skills card wins over the other two", async () => {
    const out = await resolveBoundCard({
      claim: { candidateRefs: ["r", "h", "s"], focusedRef: "h" },
      actorCtx: ACTOR,
      countOpenCards: countsOne,
      resolve: resolverOver({ r: review, h: hold, s: proposal }),
    });
    expect(out).toMatchObject({ kind: "bound", ref: "h", resolution: hold });
  });
});

describe("what each card kind lends", () => {
  it("a skills card lends its own two buttons and nothing more", () => {
    expect(controlsLentBy(hold as never)).toEqual(["confirm", "skip"]);
  });

  it("a schedule card lends Adjust and Confirm and nothing more", () => {
    expect(controlsLentBy(proposal as never)).toEqual(["adjust", "confirm"]);
  });
});

// -------------------------------------------------------------------------
// Acceptance items 1, 2 and 4 — the MENU comes from the person's own words.
// -------------------------------------------------------------------------

describe("the typed menu is the card's own controls, narrowed by the person's words", () => {
  it("a review card with a plain request for changes offers COMMENT only", () => {
    expect(typedControlMenuFor(review, "the second paragraph overstates the result")).toEqual([
      "comment",
    ]);
  });

  it("a review card with 'approve it' offers comment AND approve", () => {
    expect(typedControlMenuFor(review, "approve it")).toEqual(["comment", "approve"]);
  });

  it("a review card with 'reject it' offers comment AND reject", () => {
    expect(typedControlMenuFor(review, "reject it")).toEqual(["comment", "reject"]);
  });

  it("a skills card offers confirm ONLY when the person asked to confirm", () => {
    expect(typedControlMenuFor(hold, "drop the research skill and confirm")).toEqual(["confirm"]);
    expect(typedControlMenuFor(hold, "what does the research skill do?")).toEqual([]);
    expect(typedControlMenuFor(hold, "skip the skills")).toEqual(["skip"]);
  });

  it("a schedule card always offers adjust — it arms nothing — and confirm only when asked", () => {
    expect(typedControlMenuFor(proposal, "make it 8 in the morning on weekdays")).toEqual([
      "adjust",
    ]);
    expect(typedControlMenuFor(proposal, "make it 8 in the morning on weekdays and confirm")).toEqual(
      ["adjust", "confirm"],
    );
  });

  it("a waiting screen and the scheduler form are untouched by this slice", () => {
    expect(typedControlMenuFor({ kind: "hitl_screen" } as never, "make it say hello")).toEqual([
      "submit",
    ]);
    expect(typedControlMenuFor({ kind: "schedule_form" } as never, "8am weekdays")).toEqual([
      "fill",
    ]);
  });
});

// -------------------------------------------------------------------------
// Acceptance item 4 — the assistant cannot trigger a decision the person did
// not ask for, because the GRANT never carries one.
// -------------------------------------------------------------------------

describe("the grant carries only what the person's own message named", () => {
  async function grantFor(resolution: unknown, words: string) {
    const out = await issueTurnLentActionGrant({
      claim: { candidateRefs: ["x"], focusedRef: "x" },
      userId: "u",
      orgId: "o",
      messageId: "msg-1",
      messageText: words,
      deps: {
        resolveActor: (async () => ACTOR) as never,
        resolveBinding: (async () => ({
          kind: "bound",
          ref: "x",
          resolution,
          controls: controlsLentBy(resolution as never),
        })) as never,
        record: (async () => true) as never,
        sweep: (async () => undefined) as never,
      },
    });
    return out;
  }

  it("mints approve for a message that asked to approve", async () => {
    const out = await grantFor(review, "approve it");
    const claims = verifyLentActionGrant(out.grant!);
    expect(claims?.controls).toEqual(["comment", "approve"]);
  });

  it("mints NO approve for a message that did not ask for one", async () => {
    const out = await grantFor(review, "the second paragraph overstates the result");
    const claims = verifyLentActionGrant(out.grant!);
    expect(claims?.controls).toEqual(["comment"]);
    expect(claims?.control).toBe("comment");
  });

  it("mints nothing at all for a skills card the person only asked about", async () => {
    const out = await grantFor(hold, "what does the research skill do?");
    expect(out.grant).toBeNull();
  });

  it("tells the assistant which controls this message may press", async () => {
    const out = await grantFor(hold, "drop the research skill and confirm");
    expect(out.systemContext).toContain("BOUND CARD");
    expect(out.systemContext).toContain("confirm");
    // The offered skills are named, so a keep/drop addresses what the card shows.
    expect(out.systemContext).toContain("sk_research");
  });

  // THE SENTENCE THE MODEL IS TOLD MUST MATCH WHAT THE SERVER DOES
  // (convergence round 2, findings 2 and 3). An instruction the handler then
  // refuses is worse than no instruction: it spends the grant and lands nothing.
  it("tells the skills card's assistant that an unoffered id refuses the whole call", async () => {
    const out = await grantFor(hold, "drop the research skill and confirm");
    expect(out.systemContext).toContain("REFUSES THE WHOLE CALL");
    expect(out.systemContext).not.toContain("is dropped by the server");
  });

  it("tells the schedule card's assistant that a described change is an ADJUST, never a confirm", async () => {
    const out = await grantFor(proposal, "make it 8 in the morning on weekdays and confirm");
    expect(out.systemContext).toContain("`schedule` you pass — REQUIRED for it");
    // THE SENTENCE THAT MATTERS: a described change reaches adjust even when the
    // person asked for a confirm in the same breath. Without it the model has no
    // reason not to try the refused path (convergence round 3, finding 10).
    expect(out.systemContext).toContain(
      "even when the person also asked for it to be confirmed",
    );
    expect(out.systemContext).toContain("Never pass `schedule` with it");
    expect(out.systemContext).toContain("REFUSED and presses nothing");
    expect(out.systemContext).not.toContain("confirmed as one");
  });
});
