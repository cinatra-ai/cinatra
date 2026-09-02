// THE REVIEWED TARGET'S HEADER — what it may read, and what it may never cost
// (cinatra#3141 item 7, convergence round 2).
//
// Three things are asserted here and nothing else: WHICH artifact read each
// reading takes (a pending gate reads live, so a tombstoned row stays withheld
// exactly as the ordinary pending target reading withholds it; only the settled
// reading goes historical, for the pinned revision it decided on), WHAT a state
// that presents no target may carry (nothing), and what a legal-but-long row may
// COST (the header's wording, never the card).

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-refs";

const readReviewGate = vi.fn();
vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  readReviewGate: (...args: unknown[]) => readReviewGate(...args),
}));

const readArtifactForDetail = vi.fn();
const readArtifactForSettledReview = vi.fn();
vi.mock("@/lib/artifacts/artifact-service", () => ({
  readArtifactForDetail: (...args: unknown[]) => readArtifactForDetail(...args),
  readArtifactForSettledReview: (...args: unknown[]) => readArtifactForSettledReview(...args),
}));

vi.mock("@/lib/authz/build-actor-context", () => ({
  buildActorContextFromPrimitive: () => ({ actor: "actor" }),
}));

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import {
  LIFECYCLE_TARGET_HEADERS_MAX,
  LIFECYCLE_TARGET_HEADER_MAX_TEXT,
  lifecycleTargetHeadersSchema,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

import { encodeLifecycleGateRef } from "../lifecycle-card-ref";
import { readReviewTargetHeaders } from "../lifecycle-target-headers";

const REF = encodeLifecycleGateRef({ runId: "run-1", reviewTaskId: "task-1" })!;
const ACTOR = { actor: { kind: "user", id: "usr_1" }, orgId: "org-1", roleHints: [] } as never;

const PENDING: LifecycleCardState = { state: "pending", canDecide: true, canComment: true };
const RESTRICTED: LifecycleCardState = {
  state: "restricted",
  canDecide: false,
  canComment: false,
  reason: "You can view this review but not respond to it.",
};
const SETTLED_DECIDED: LifecycleCardState = { state: "settled", outcome: "approved" };
const SETTLED_UNREADABLE: LifecycleCardState = { state: "settled" };

function gate(targets = [{ artifactId: "art-1", representationRevisionId: "rev_8f3a1c2d" }]) {
  return { id: "gate-1", runId: "run-1", reviewTaskId: "task-1", pinnedTargets: targets };
}

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    kind: "ok" as const,
    artifact: {
      artifactId: "art-1",
      title: "Q3 re-engagement email",
      objectType: "@cinatra-ai/email:draft",
      ownerLevel: "team",
      visibility: "private",
      mime: "text/html",
      updatedAt: "2026-08-31T08:19:26.458Z",
      ...overrides,
    },
  };
}

function read(state: LifecycleCardState) {
  return readReviewTargetHeaders({
    viewType: "artifact_review_gate",
    ref: REF,
    state,
    actorCtx: ACTOR,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  readReviewGate.mockResolvedValue(gate());
  readArtifactForDetail.mockReturnValue(artifact());
  readArtifactForSettledReview.mockReturnValue(artifact());
});

describe("which read each reading takes", () => {
  it("a PENDING gate reads the artifact LIVE — a tombstoned row is withheld, as the pending target reading withholds it", async () => {
    await read(PENDING);
    expect(readArtifactForDetail).toHaveBeenCalledTimes(1);
    expect(readArtifactForSettledReview).not.toHaveBeenCalled();
  });

  it("a RESTRICTED gate reads live too — the reading is the same one, minus the affordances", async () => {
    await read(RESTRICTED);
    expect(readArtifactForDetail).toHaveBeenCalledTimes(1);
    expect(readArtifactForSettledReview).not.toHaveBeenCalled();
  });

  it("only the SETTLED reading goes historical — a gate holds its decision to the revision it pinned", async () => {
    await read(SETTLED_DECIDED);
    expect(readArtifactForSettledReview).toHaveBeenCalledTimes(1);
    expect(readArtifactForDetail).not.toHaveBeenCalled();
  });

  it("a tombstoned row costs the pending header and nothing else", async () => {
    readArtifactForDetail.mockReturnValue({ kind: "not-found" });
    expect(await read(PENDING)).toBeNull();
  });
});

describe("a state that presents no target carries no header", () => {
  it("a settled gate whose outcome this build cannot read names nothing — the card draws no target there either", async () => {
    expect(await read(SETTLED_UNREADABLE)).toBeNull();
    expect(readReviewGate).not.toHaveBeenCalled();
    expect(readArtifactForSettledReview).not.toHaveBeenCalled();
  });

  it("`absent` — the collapse of every denial — reads nothing at all", async () => {
    expect(await read({ state: "absent" })).toBeNull();
    expect(readReviewGate).not.toHaveBeenCalled();
  });

  it("a kind with no review target never reads a gate", async () => {
    expect(
      await readReviewTargetHeaders({
        viewType: "verification_summary",
        ref: REF,
        state: PENDING,
        actorCtx: ACTOR,
      }),
    ).toBeNull();
    expect(readReviewGate).not.toHaveBeenCalled();
  });
});

describe("a legal row can cost the header's wording, never the card", () => {
  it("a title longer than the wire's bound is TRIMMED, not refused — the envelope still parses", async () => {
    const longTitle = "T".repeat(500);
    readArtifactForDetail.mockReturnValue(artifact({ title: longTitle }));

    const headers = await read(PENDING);

    expect(headers).not.toBeNull();
    expect(headers![0]!.title).toHaveLength(LIFECYCLE_TARGET_HEADER_MAX_TEXT);
    // The whole point: what is composed here is what the parser accepts, so a
    // 500-character title cannot refuse the answer and blank the gate.
    expect(lifecycleTargetHeadersSchema.safeParse(headers).success).toBe(true);
  });

  it("a row with no title at all falls back to its id rather than composing a value the wire refuses", async () => {
    readArtifactForDetail.mockReturnValue(artifact({ title: "" }));
    const headers = await read(PENDING);
    expect(headers![0]!.title).toBe("art-1");
    expect(lifecycleTargetHeadersSchema.safeParse(headers).success).toBe(true);
  });

  it("never composes more headers than the wire may carry", async () => {
    readReviewGate.mockResolvedValue(
      gate(
        Array.from({ length: LIFECYCLE_TARGET_HEADERS_MAX + 4 }, (_, i) => ({
          artifactId: `art-${i}`,
          representationRevisionId: `rev_${i}`,
        })),
      ),
    );
    const headers = await read(PENDING);
    expect(headers).toHaveLength(LIFECYCLE_TARGET_HEADERS_MAX);
    expect(lifecycleTargetHeadersSchema.safeParse(headers).success).toBe(true);
  });

  it("a store that throws costs the header, never the card", async () => {
    readReviewGate.mockRejectedValue(new Error("gate store down"));
    expect(await read(PENDING)).toBeNull();
  });
});
