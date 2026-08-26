// THE BOUND CARD IS RE-CHECKED ON THE SERVER (cinatra#2932, lifecycle-b W5a).
//
// The plan's two claims this file settles:
//
//   "the message carries that fact as a reference the server re-checks under
//    your own identity"
//
//   "For the platform to be able to say 'several things are waiting', the
//    message must carry a checked fact that more than one was open to you — so
//    that state is confirmed by the server, not decided by the page alone."
//
// So: the page's claim is INPUT. What binds is decided here, from what survives
// the reader's own access.

import { describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-bound-card-binding";

vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  enforceReviewRunAccess: vi.fn(),
  readGatePinnedTargets: vi.fn(),
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  readLatestDurableHitlGateArtifact: vi.fn(),
}));

import {
  MAX_BOUND_CANDIDATE_REFS,
  primaryControlFor,
  resolveBoundCard,
  severalCardsWaitingRefusal,
} from "../bound-card-binding";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

const ACTOR = { actor: { userId: "u" }, orgId: "o", roleHints: {} } as unknown as ReviewActorContext;

/** The server's own count. Defaults to "one card open" so each case states the
 *  ambiguity it is really about rather than inheriting one. */
const countsOne = async () => ({ count: 1, complete: true });

const review = (id: string) =>
  ({ kind: "review", runId: `run-${id}`, reviewTaskId: id, pinnedTargets: [] }) as const;
const absent = { kind: "absent" } as const;

/** A resolver stand-in: only the refs listed are really this reader's. */
function resolverOver(readable: Record<string, unknown>) {
  return vi.fn(async ({ ref }: { ref: string }) => readable[ref] ?? absent) as never;
}

describe("one open card binds on its own", () => {
  it("binds the single surviving card and reports what it lends", async () => {
    const out = await resolveBoundCard({
      claim: { candidateRefs: ["a"], focusedRef: null },
      actorCtx: ACTOR,
      countOpenCards: countsOne,
      resolve: resolverOver({ a: review("a") }),
    });
    expect(out).toMatchObject({ kind: "bound", ref: "a" });
    expect((out as unknown as { controls: string[] }).controls).toEqual([
      "comment",
      "approve",
      "reject",
    ]);
  });
});

describe("the page's claim is INPUT, never the answer", () => {
  it("a page offering ten refs the reader cannot see binds NOTHING", async () => {
    const out = await resolveBoundCard({
      claim: { candidateRefs: ["a", "b", "c"], focusedRef: "a" },
      actorCtx: ACTOR,
      countOpenCards: countsOne,
      resolve: resolverOver({}),
    });
    expect(out).toEqual({ kind: "none" });
  });

  it("a page claiming ONE card while TWO are really open still gets the refusal", async () => {
    const out = await resolveBoundCard({
      // The page says nothing was picked; two cards are genuinely readable.
      claim: { candidateRefs: ["a", "b"], focusedRef: null },
      actorCtx: ACTOR,
      countOpenCards: countsOne,
      resolve: resolverOver({ a: review("a"), b: review("b") }),
    });
    expect(out).toEqual({
      kind: "ambiguous",
      count: 2,
      refusal: severalCardsWaitingRefusal(2),
    });
  });

  it("two cards of which only ONE is really the reader's binds that one", async () => {
    const out = await resolveBoundCard({
      claim: { candidateRefs: ["a", "b"], focusedRef: null },
      actorCtx: ACTOR,
      countOpenCards: countsOne,
      resolve: resolverOver({ b: review("b") }),
    });
    expect(out).toMatchObject({ kind: "bound", ref: "b" });
  });

  it("a repeated ref cannot manufacture ambiguity", async () => {
    const out = await resolveBoundCard({
      claim: { candidateRefs: ["a", "a", "a"], focusedRef: null },
      actorCtx: ACTOR,
      countOpenCards: countsOne,
      resolve: resolverOver({ a: review("a") }),
    });
    expect(out).toMatchObject({ kind: "bound", ref: "a" });
  });

  it("bounds how many candidates one message may carry", async () => {
    const many = Array.from({ length: MAX_BOUND_CANDIDATE_REFS + 5 }, (_v, i) => `r${i}`);
    const resolve = resolverOver({});
    await resolveBoundCard({
      claim: { candidateRefs: many, focusedRef: null },
      actorCtx: ACTOR,
      resolve,
    });
    expect((resolve as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(
      MAX_BOUND_CANDIDATE_REFS,
    );
  });
});

describe("an explicit pick wins — while it is still live", () => {
  it("the picked card beats the others", async () => {
    const out = await resolveBoundCard({
      claim: { candidateRefs: ["a", "b"], focusedRef: "b" },
      actorCtx: ACTOR,
      countOpenCards: countsOne,
      resolve: resolverOver({ a: review("a"), b: review("b") }),
    });
    expect(out).toMatchObject({ kind: "bound", ref: "b" });
  });

  it("a STALE pick binds NOTHING — it never falls through to another card", async () => {
    const out = await resolveBoundCard({
      claim: { candidateRefs: ["a", "b"], focusedRef: "b" },
      actorCtx: ACTOR,
      countOpenCards: countsOne,
      // `b` was decided elsewhere while the reader typed.
      resolve: resolverOver({ a: review("a") }),
    });
    // AMENDED by convergence round 1, finding 4. This case used to assert the
    // page-side fallthrough; with an AUTHORITY attached to the binding, falling
    // through would mint a grant over a card the person did not choose. The
    // dedicated block below states the rule and its reason in full.
    expect(out).toEqual({ kind: "none" });
  });
});

describe("the refusal is the platform's own words", () => {
  it("names the count and the way out, and carries NO identifiers", () => {
    const line = severalCardsWaitingRefusal(3);
    expect(line).toContain("3 cards are waiting");
    expect(line).toContain("nothing was done");
    expect(line).not.toMatch(/run|gate|ref|id/i);
  });
});

describe("a resolver that throws contributes nothing", () => {
  it("does not turn a store failure into a binding", async () => {
    const out = await resolveBoundCard({
      claim: { candidateRefs: ["a"], focusedRef: null },
      actorCtx: ACTOR,
      countOpenCards: countsOne,
      resolve: (async () => {
        throw new Error("store down");
      }) as never,
    });
    expect(out).toEqual({ kind: "none" });
  });
});

describe("a STALE explicit pick binds NOTHING — convergence round 1, finding 4", () => {
  it("does NOT fall through to the other live card", async () => {
    // The person chose B. B settled while they typed. A is still live. Binding A
    // would mint an authority over a card they did not choose, carrying the words
    // they wrote for the one they did. The page-side focus reducer may fall
    // through here; this one must not, and the two rules differ deliberately.
    const out = await resolveBoundCard({
      claim: { candidateRefs: ["a", "b"], focusedRef: "b" },
      actorCtx: ACTOR,
      countOpenCards: countsOne,
      resolve: resolverOver({ a: review("a") }),
    });
    expect(out).toEqual({ kind: "none" });
  });

  it("a LIVE explicit pick still wins outright", async () => {
    const out = await resolveBoundCard({
      claim: { candidateRefs: ["a", "b"], focusedRef: "b" },
      actorCtx: ACTOR,
      countOpenCards: countsOne,
      resolve: resolverOver({ a: review("a"), b: review("b") }),
    });
    expect(out).toMatchObject({ kind: "bound", ref: "b" });
  });
});

describe("the ambiguity fact is the SERVER'S — convergence round 1, finding 5", () => {
  it("a client that sends ONE ref while TWO are really open gets the refusal anyway", async () => {
    const out = await resolveBoundCard({
      // The page claims a single card and no pick — the shape that used to bind
      // automatically. The server knows better.
      claim: { candidateRefs: ["a"], focusedRef: null },
      actorCtx: ACTOR,
      countOpenCards: async () => ({ count: 2, complete: true }),
      resolve: resolverOver({ a: review("a") }),
    });
    expect(out).toEqual({
      kind: "ambiguous",
      count: 2,
      refusal: severalCardsWaitingRefusal(2),
    });
  });

  it("an EXPLICIT pick is not second-guessed by the count — the person chose", async () => {
    const out = await resolveBoundCard({
      claim: { candidateRefs: ["a"], focusedRef: "a" },
      actorCtx: ACTOR,
      countOpenCards: async () => ({ count: 5, complete: true }),
      resolve: resolverOver({ a: review("a") }),
    });
    expect(out).toMatchObject({ kind: "bound", ref: "a" });
  });

  it("a count that CANNOT ANSWER lends nothing — convergence round 2", async () => {
    // The counter reads a bounded window, so "saw nothing" and "could not run"
    // are both real outcomes. Neither is "one is open": with nothing clearly
    // bound, no control is lent at all, and the person presses the card.
    const out = await resolveBoundCard({
      claim: { candidateRefs: ["a"], focusedRef: null },
      actorCtx: ACTOR,
      countOpenCards: async () => {
        throw new Error("store down");
      },
      resolve: resolverOver({ a: review("a") }),
    });
    expect(out).toMatchObject({ kind: "ambiguous" });
  });

  it("a count that SAW NOTHING lends nothing either — the reader's card sat outside the window", async () => {
    const out = await resolveBoundCard({
      claim: { candidateRefs: ["a"], focusedRef: null },
      actorCtx: ACTOR,
      countOpenCards: async () => ({ count: 0, complete: true }),
      resolve: resolverOver({ a: review("a") }),
    });
    expect(out).toMatchObject({ kind: "ambiguous" });
  });

  it("ONLY a confirmed single card binds on its own", async () => {
    const out = await resolveBoundCard({
      claim: { candidateRefs: ["a"], focusedRef: null },
      actorCtx: ACTOR,
      countOpenCards: async () => ({ count: 1, complete: true }),
      resolve: resolverOver({ a: review("a") }),
    });
    expect(out).toMatchObject({ kind: "bound", ref: "a" });
  });
});

describe("what a SEND may lend today — convergence round 1, finding 1", () => {
  it("a bound review lends COMMENT and nothing else", () => {
    expect(primaryControlFor(review("a"))).toBe("comment");
  });

  it("a waiting screen lends NOTHING yet — pressing Continue resumes a run", () => {
    expect(
      primaryControlFor({
        kind: "hitl_screen",
        runId: "r",
        screenRef: "g",
        xRenderer: "x",
        form: { schema: {}, values: {} },
      }),
    ).toBeNull();
  });

  it("an absent binding lends nothing", () => {
    expect(primaryControlFor({ kind: "absent" })).toBeNull();
  });
});

describe("only a COMPLETE count confirms — convergence round 3", () => {
  it("a count of ONE from a scan that could not see everything lends nothing", async () => {
    const out = await resolveBoundCard({
      claim: { candidateRefs: ["a"], focusedRef: null },
      actorCtx: ACTOR,
      // One visible, but the scan filled its window or dropped a row it could
      // not check — the rows it missed are exactly the ones that would matter.
      countOpenCards: async () => ({ count: 1, complete: false }),
      resolve: resolverOver({ a: review("a") }),
    });
    expect(out).toMatchObject({ kind: "ambiguous" });
  });

  it("an incomplete count of TWO still refuses, and says two", async () => {
    const out = await resolveBoundCard({
      claim: { candidateRefs: ["a", "b"], focusedRef: null },
      actorCtx: ACTOR,
      countOpenCards: async () => ({ count: 2, complete: false }),
      resolve: resolverOver({ a: review("a"), b: review("b") }),
    });
    expect(out).toMatchObject({ kind: "ambiguous", count: 2 });
  });
});
