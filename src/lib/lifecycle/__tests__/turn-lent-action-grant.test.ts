// WHAT A SEND ACTUALLY LENDS (cinatra#2932, lifecycle-b W5a) — the mint, and the
// four things it refuses to lend.
//
// `resolveBoundCard` decides WHICH card a message is bound to; this is the
// entry that turns that into an authority, and most of what it does is decline:
//
//   · a waiting screen lends nothing yet — pressing Continue resumes a run, and
//     deciding that a sentence asked for that is cinatra#2853's (convergence round 1);
//   · an EMPTY message lends nothing — there is nothing to place;
//   · a message longer than the card's own path accepts lends nothing, rather
//     than being silently shortened into one it does accept (convergence round 2);
//   · a ledger row that lost its race lends nothing — an authority the ledger
//     will refuse is never handed out.
//
// And when it DOES lend, it carries the person's own words into the row, which
// is what makes "word for word" a property of the mechanism.

import { describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-turn-grant";

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

import {
  MAX_LENT_COMMENT_CHARS,
  issueTurnLentActionGrant,
} from "../bound-card-binding";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

const ACTOR = {
  actor: { actorType: "human", source: "agent", userId: "usr_1", orgId: "org_1" },
  orgId: "org_1",
  roleHints: { actorOrganizationId: "org_1" },
} as unknown as ReviewActorContext;

const REVIEW_BINDING = {
  kind: "bound" as const,
  ref: "ref-a",
  resolution: {
    kind: "review" as const,
    runId: "run_1",
    reviewTaskId: "gate_1",
    pinnedTargets: [],
  },
  controls: ["comment", "approve", "reject"] as const,
};

function deps(over: Record<string, unknown> = {}) {
  return {
    resolveActor: vi.fn(async () => ACTOR),
    resolveBinding: vi.fn(async () => REVIEW_BINDING),
    record: vi.fn(async () => true),
    sweep: vi.fn(async () => undefined),
    ...over,
  } as never;
}

const CLAIM = { candidateRefs: ["ref-a"], focusedRef: null };

async function issue(over: Record<string, unknown> = {}, d = deps()) {
  return issueTurnLentActionGrant({
    claim: CLAIM,
    userId: "usr_1",
    orgId: "org_1",
    messageId: "turn_1",
    messageText: "tighten the opening paragraph",
    deps: d,
    ...over,
  });
}

describe("a bound review lends ONE control, with the person's own words", () => {
  it("mints a grant and records the message text", async () => {
    const d = deps();
    const out = await issue({}, d);
    expect(out.grant).toEqual(expect.any(String));
    const record = (d as unknown as { record: { mock: { calls: unknown[][] } } }).record;
    expect(record.mock.calls[0][0]).toMatchObject({ control: "comment" });
    expect(record.mock.calls[0][1]).toBe("tighten the opening paragraph");
  });

  it("tells the turn which ONE control it may press, and to add nothing", async () => {
    const out = await issue();
    expect(out.systemContext).toContain('control "comment"');
    expect(out.systemContext).toContain("You supply NO text");
  });

  it("SWEEPS BEFORE IT INSERTS — the collection is paid on the path that creates the debt", async () => {
    const order: string[] = [];
    const d = deps({
      sweep: vi.fn(async () => {
        order.push("sweep");
      }),
      record: vi.fn(async () => {
        order.push("record");
        return true;
      }),
    });
    await issue({}, d);
    expect(order).toEqual(["sweep", "record"]);
  });
});

describe("what a send declines to lend", () => {
  // AMENDED for cinatra#2934 (lifecycle-b W5c): a waiting screen now lends both
  // of its roads, and the model is told them apart — filling is the ordinary
  // one, pressing is the one that has to be asked for.
  it("lends BOTH roads for a waiting screen, and names them apart", async () => {
    const out = await issue(
      {},
      deps({
        resolveBinding: vi.fn(async () => ({
          kind: "bound",
          ref: "ref-a",
          resolution: {
            kind: "hitl_screen",
            runId: "run_1",
            screenRef: "gate_1",
            xRenderer: "setup-field",
            form: { schema: {}, values: {} },
          },
          controls: ["submit"],
        })),
      }),
    );
    expect(out.grant).not.toBeNull();
    expect(out.systemContext).toContain("BOUND SCREEN");
    expect(out.systemContext).toContain("lifecycle_bound_screen_fill");
    expect(out.systemContext).toContain("SUBMITS NOTHING");
    expect(out.systemContext).toContain("ONLY when the person asks for that in so many words");
    expect(out.systemContext).toContain('control "submit"');
  });

  it("lends NOTHING for an empty message — there is nothing to place", async () => {
    for (const text of ["", "   ", null]) {
      const out = await issue({ messageText: text });
      expect(out.grant, String(text)).toBeNull();
    }
  });

  it("lends NOTHING for a message the card's own path would refuse as too long", async () => {
    const out = await issue({ messageText: "x".repeat(MAX_LENT_COMMENT_CHARS + 1) });
    expect(out).toEqual({ grant: null, systemContext: "" });
    // ...and the last message it WOULD accept still lends.
    const ok = await issue({ messageText: "x".repeat(MAX_LENT_COMMENT_CHARS) });
    expect(ok.grant).toEqual(expect.any(String));
  });

  it("lends NOTHING when the ledger row lost its race", async () => {
    const out = await issue({}, deps({ record: vi.fn(async () => false) }));
    expect(out).toEqual({ grant: null, systemContext: "" });
  });

  it("lends NOTHING when the person has no live standing", async () => {
    const out = await issue({}, deps({ resolveActor: vi.fn(async () => null) }));
    expect(out).toEqual({ grant: null, systemContext: "" });
  });

  it("lends NOTHING when the composer had no card at all", async () => {
    const out = await issue({ claim: null });
    expect(out).toEqual({ grant: null, systemContext: "" });
  });
});

describe("several cards waiting: the platform refuses and the assistant relays", () => {
  it("mints no grant and hands the turn the platform's own words", async () => {
    const out = await issue(
      {},
      deps({
        resolveBinding: vi.fn(async () => ({
          kind: "ambiguous",
          count: 2,
          refusal: "2 cards are waiting for you, so nothing was done to any of them.",
        })),
      }),
    );
    expect(out.grant).toBeNull();
    expect(out.systemContext).toContain("word for word");
    expect(out.systemContext).toContain("2 cards are waiting");
    expect(out.systemContext).toContain("You hold no authority");
  });
});
