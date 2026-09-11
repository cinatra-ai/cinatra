// THE BOUND-REFERENCE RESOLVER (cinatra#2932, lifecycle-b W5a) — acceptance
// item 5:
//
//   "A foreign bound reference is refused and the resolver returns the pinned
//    revision, never the latest."
//
// The three properties this file exists for:
//
//   · RUN READ BEFORE THE ROW. The access check runs before any gate or screen
//     row is touched, so holding a ref cannot be used to learn what is behind it.
//     Proved by ORDER, not by assertion: the row ports throw if they are reached
//     for an unreadable run.
//   · THE PINNED REVISION, NEVER THE LATEST. The gate's frozen set is what comes
//     back even when the artifact has moved on.
//   · ONE UNIFORM ABSENCE for every failure.

import { describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-bound-reference";

vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  enforceReviewRunAccess: vi.fn(),
  readGatePinnedTargets: vi.fn(),
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  readLatestDurableHitlGateArtifact: vi.fn(),
}));

import { encodeLifecycleGateRef } from "../lifecycle-card-ref";
import { controlsLentBy, resolveBoundReference } from "../bound-reference-resolver";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

const ACTOR = {
  actor: { actorType: "human", source: "agent", userId: "usr_1", orgId: "org_1" },
  orgId: "org_1",
  roleHints: { actorOrganizationId: "org_1" },
} as unknown as ReviewActorContext;

const RUN = "run_1";
const GATE = "gate_1";
const REF = encodeLifecycleGateRef({ runId: RUN, reviewTaskId: GATE })!;

/** The PINNED set — an artifact at an EXACT representation revision. */
const PINNED = [{ artifactId: "art_1", representationRevisionId: "rev_1" }];
/** What the artifact looks like NOW. The resolver must never reach for this. */
const LATEST = [{ artifactId: "art_1", representationRevisionId: "rev_9" }];

function ports(over: Record<string, unknown> = {}) {
  return {
    enforceRunRead: async () => true,
    readPinnedTargets: async () => ({ status: "pending", targets: PINNED }),
    readParkedScreen: async () => null,
    ...over,
  } as never;
}

describe("a ref that is not this reader's resolves to nothing", () => {
  it("a ref that does not decode is absent", async () => {
    const out = await resolveBoundReference({
      ref: "not-a-ref",
      actorCtx: ACTOR,
      ports: ports(),
    });
    expect(out).toEqual({ kind: "absent" });
  });

  it("a FOREIGN ref — a real ref for a run this reader may not read — is absent, and no row is touched", async () => {
    const readPinnedTargets = vi.fn(async () => {
      throw new Error("the gate row must not be read for an unreadable run");
    });
    const readParkedScreen = vi.fn(async () => {
      throw new Error("the screen row must not be read for an unreadable run");
    });
    const out = await resolveBoundReference({
      ref: REF,
      actorCtx: ACTOR,
      ports: ports({ enforceRunRead: async () => false, readPinnedTargets, readParkedScreen }),
    });
    expect(out).toEqual({ kind: "absent" });
    expect(readPinnedTargets).not.toHaveBeenCalled();
    expect(readParkedScreen).not.toHaveBeenCalled();
  });

  it("an access check that THROWS is absent, never an open door", async () => {
    const out = await resolveBoundReference({
      ref: REF,
      actorCtx: ACTOR,
      ports: ports({
        enforceRunRead: async () => {
          throw new Error("store down");
        },
      }),
    });
    expect(out).toEqual({ kind: "absent" });
  });
});

describe("the review arm answers the PINNED revision", () => {
  it("returns the gate's frozen set — item 5, never the latest", async () => {
    const out = await resolveBoundReference({
      ref: REF,
      actorCtx: ACTOR,
      ports: ports(),
    });
    expect(out).toEqual({
      kind: "review",
      runId: RUN,
      reviewTaskId: GATE,
      pinnedTargets: PINNED,
    });
    expect(out).not.toMatchObject({ pinnedTargets: LATEST });
  });

  it("still answers the pinned revision when the artifact has moved on", async () => {
    // The port that would answer "what is the artifact now" is deliberately not
    // one this resolver has: the ONLY target source is the gate's own pinned set.
    const out = await resolveBoundReference({
      ref: REF,
      actorCtx: ACTOR,
      ports: ports({
        readPinnedTargets: async () => ({ status: "pending", targets: PINNED }),
      }),
    });
    expect((out as unknown as { pinnedTargets: unknown[] }).pinnedTargets).toEqual([
      { artifactId: "art_1", representationRevisionId: "rev_1" },
    ]);
  });

  it("a gate that is no longer pending is absent, not a stale review", async () => {
    const out = await resolveBoundReference({
      ref: REF,
      actorCtx: ACTOR,
      ports: ports({ readPinnedTargets: async () => ({ status: "not-pending" }) }),
    });
    expect(out).toEqual({ kind: "absent" });
  });
});

describe("the HITL arm answers the screen the run is PARKED at", () => {
  const SCREEN = {
    runId: RUN,
    reviewTaskId: GATE,
    xRenderer: "setup-field",
    inputSchema: { type: "object", properties: { url: { type: "string" } } },
    values: { url: "https://example.invalid" },
    fieldName: "url",
  };

  it("returns the screen's form schema and its current values", async () => {
    const out = await resolveBoundReference({
      ref: REF,
      actorCtx: ACTOR,
      ports: ports({
        readPinnedTargets: async () => ({ status: "not-found" }),
        readParkedScreen: async () => SCREEN,
      }),
    });
    expect(out).toEqual({
      kind: "hitl_screen",
      runId: RUN,
      screenRef: GATE,
      xRenderer: "setup-field",
      form: { schema: SCREEN.inputSchema, values: SCREEN.values, fieldName: "url" },
    });
  });

  it("a ref for a screen the run has MOVED PAST is absent — never the next screen", async () => {
    const out = await resolveBoundReference({
      ref: REF,
      actorCtx: ACTOR,
      ports: ports({
        readPinnedTargets: async () => ({ status: "not-found" }),
        readParkedScreen: async () => ({ ...SCREEN, reviewTaskId: "gate_2" }),
      }),
    });
    expect(out).toEqual({ kind: "absent" });
  });
});

describe("a card that offers no decision lends none", () => {
  it("a review lends its own three buttons", () => {
    expect(controlsLentBy({ kind: "review", runId: RUN, reviewTaskId: GATE, pinnedTargets: [] })).toEqual([
      "comment",
      "approve",
      "reject",
    ]);
  });

  // AMENDED for cinatra#2934 (lifecycle-b W5c). W5a asserted `["submit"]`
  // because the fill road did not exist yet; the plan's "fill and submit where
  // fields wait" is now both, and they are deliberately different in kind — a
  // fill presses nothing and spends no grant, a submit is the button.
  it("a HITL screen lends Fill and Submit", () => {
    expect(
      controlsLentBy({
        kind: "hitl_screen",
        runId: RUN,
        screenRef: GATE,
        xRenderer: "r",
        form: { schema: {}, values: {} },
      }),
    ).toEqual(["fill", "submit"]);
  });

  it("an absent binding lends NOTHING", () => {
    expect(controlsLentBy({ kind: "absent" })).toEqual([]);
  });
});
