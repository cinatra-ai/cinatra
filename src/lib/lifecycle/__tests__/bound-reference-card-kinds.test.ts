// THE BOUND-REFERENCE RESOLVER ANSWERS EVERY LIFECYCLE CARD KIND (cinatra#2853)
// — acceptance item 3's read half.
//
// Plan (A) §2.3 item 6: "The prompt window cannot yet act on the active card …
// plus the deterministic pick-the-card binding itself. Only the review-comment
// binding exists."
//
// The binding rule is only as complete as the resolver under it: a card kind the
// resolver cannot name can never be the active card. These cases pin the two
// kinds this slice adds, and pin that the resolver still discloses nothing about
// a card the reader may not act on.

import { describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-card-kinds";

vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  enforceReviewRunAccess: vi.fn(async () => ({ ok: true })),
  readGatePinnedTargets: vi.fn(),
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  readLatestDurableHitlGateArtifact: vi.fn(),
}));
vi.mock("@cinatra-ai/agents/trigger-store", () => ({ readRunTriggerByRunId: vi.fn() }));

import {
  decodeRecommendationHoldRef,
  encodeRecommendationHoldRef,
} from "@cinatra-ai/agents/recommendation-hold";
import { controlsLentBy, resolveBoundReference } from "../bound-reference-resolver";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

const ACTOR = {
  actor: { actorType: "human", source: "ui", userId: "u" },
  orgId: "o",
  roleHints: {},
} as unknown as ReviewActorContext;

const HOLD_REF = encodeRecommendationHoldRef({ runId: "run_h", holdId: "hold_1" })!;

function ports(over: Record<string, unknown> = {}) {
  return {
    enforceRunRead: async () => true,
    readPinnedTargets: async () => ({ status: "decided", targets: [] }),
    readParkedScreen: async () => null,
    readRunTrigger: async () => null,
    readRecommendationHold: async () => ({
      state: "held",
      agentPackageName: "pkg",
      promptText: "",
      recommendations: [
        { skillId: "sk_research", name: "Research" },
        { skillId: "sk_style", name: "House style" },
      ],
      holdRef: HOLD_REF,
      canDecide: true,
    }),
    decodeHoldRef: async (ref: string) => decodeRecommendationHoldRef(ref),
    readScheduleProposal: async () => ({
      state: { state: "pending", canDecide: true, canComment: false },
      view: { schedule: { mode: "recurring" }, summary: "every weekday at 09:00" },
    }),
    ...over,
  } as never;
}

describe("the skills-recommendation card", () => {
  it("resolves a held hold under the reader's own access and names what it offers", async () => {
    const out = await resolveBoundReference({
      ref: HOLD_REF,
      actorCtx: ACTOR,
      ports: ports(),
    });
    expect(out).toMatchObject({
      kind: "recommendation_hold",
      runId: "run_h",
      holdRef: HOLD_REF,
      agentPackageName: "pkg",
    });
    expect((out as unknown as { offered: unknown[] }).offered).toEqual([
      { skillId: "sk_research", name: "Research" },
      { skillId: "sk_style", name: "House style" },
    ]);
    expect(controlsLentBy(out)).toEqual(["confirm", "skip"]);
  });

  it("is ABSENT once the hold has settled — a decided card lends nothing", async () => {
    const out = await resolveBoundReference({
      ref: HOLD_REF,
      actorCtx: ACTOR,
      ports: ports({ readRecommendationHold: async () => ({ state: "confirmed", decided: [] }) }),
    });
    expect(out).toEqual({ kind: "absent" });
    expect(controlsLentBy(out)).toEqual([]);
  });

  it("is ABSENT for a reader the hold reader answers nothing for", async () => {
    const out = await resolveBoundReference({
      ref: HOLD_REF,
      actorCtx: ACTOR,
      ports: ports({ readRecommendationHold: async () => ({ state: "none" }) }),
    });
    expect(out).toEqual({ kind: "absent" });
  });

  it("is ABSENT when the read throws — one uniform absence", async () => {
    const out = await resolveBoundReference({
      ref: HOLD_REF,
      actorCtx: ACTOR,
      ports: ports({
        readRecommendationHold: async () => {
          throw new Error("store down");
        },
      }),
    });
    expect(out).toEqual({ kind: "absent" });
  });

  it("is ABSENT for a STALE ref — the hold the run has moved past is not this card", async () => {
    // convergence round 1, finding 5. The reader answers the run's CURRENT
    // hold, so a ref for a hold that has been replaced must not resolve the one
    // that replaced it: the grant is fingerprinted to the stale ref and would
    // carry an authority over a card the person never saw.
    const OTHER = encodeRecommendationHoldRef({ runId: "run_h", holdId: "hold_2" })!;
    const out = await resolveBoundReference({
      ref: HOLD_REF,
      actorCtx: ACTOR,
      ports: ports({
        readRecommendationHold: async () => ({
          state: "held",
          agentPackageName: "pkg",
          promptText: "",
          recommendations: [{ skillId: "sk_research", name: "Research" }],
          holdRef: OTHER,
          canDecide: true,
        }),
      }),
    });
    expect(out).toEqual({ kind: "absent" });
  });

  it("is ABSENT when the card cannot say whether this reader may decide", async () => {
    // FAIL-CLOSED: `canDecide` must be TRUE, never merely "not false".
    const out = await resolveBoundReference({
      ref: HOLD_REF,
      actorCtx: ACTOR,
      ports: ports({
        readRecommendationHold: async () => ({
          state: "held",
          agentPackageName: "pkg",
          promptText: "",
          recommendations: [{ skillId: "sk_research", name: "Research" }],
          holdRef: HOLD_REF,
        }),
      }),
    });
    expect(out).toEqual({ kind: "absent" });
  });

  it("is ABSENT for a hold that cannot say what it is offering", async () => {
    const out = await resolveBoundReference({
      ref: HOLD_REF,
      actorCtx: ACTOR,
      ports: ports({
        readRecommendationHold: async () => ({
          state: "held",
          agentPackageName: "pkg",
          promptText: "",
          recommendations: [],
          holdRef: HOLD_REF,
          canDecide: true,
        }),
      }),
    });
    expect(out).toEqual({ kind: "absent" });
  });

  it("does NOT lend a decision to a reader the card itself marks read-only", async () => {
    const out = await resolveBoundReference({
      ref: HOLD_REF,
      actorCtx: ACTOR,
      ports: ports({
        readRecommendationHold: async () => ({
          state: "held",
          agentPackageName: "pkg",
          promptText: "",
          recommendations: [],
          holdRef: HOLD_REF,
          canDecide: false,
        }),
      }),
    });
    expect(out).toEqual({ kind: "absent" });
  });
});

describe("the schedule (trigger) card", () => {
  it("resolves a proposal with a live floor and lends Adjust and Confirm", async () => {
    const out = await resolveBoundReference({
      ref: "prop_token_1",
      actorCtx: ACTOR,
      ports: ports(),
    });
    expect(out).toMatchObject({ kind: "schedule_proposal", ref: "prop_token_1" });
    expect(controlsLentBy(out)).toEqual(["adjust", "confirm"]);
  });

  it("is ABSENT for a settled card — a card with no floor lends none", async () => {
    const out = await resolveBoundReference({
      ref: "prop_token_1",
      actorCtx: ACTOR,
      ports: ports({
        readScheduleProposal: async () => ({ state: { state: "settled" }, view: null }),
      }),
    });
    expect(out).toEqual({ kind: "absent" });
  });

  it("is ABSENT for a reader who may read the card but not decide it", async () => {
    const out = await resolveBoundReference({
      ref: "prop_token_1",
      actorCtx: ACTOR,
      ports: ports({
        readScheduleProposal: async () => ({
          state: { state: "restricted", canDecide: false, canComment: false, reason: "x" },
          view: null,
        }),
      }),
    });
    expect(out).toEqual({ kind: "absent" });
  });
});
