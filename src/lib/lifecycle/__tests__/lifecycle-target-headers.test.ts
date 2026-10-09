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

  it("a PARTLY readable multi-target gate names NONE of them rather than some (cinatra#3058, fix leg 8)", async () => {
    // The review drawing's target section says "Every target opens with a header
    // that names what is under review and fixes it in place" - EVERY target. A
    // gate that pins two artifacts and can name only one would draw ONE header
    // over an island rendering BOTH, and the reader would be told they are
    // deciding about that one artifact. That is the card's own sentence turned on
    // the reading as a whole: naming the wrong artifact over a review is worse
    // than naming none. So a reading that cannot open every pinned target is the
    // FACTLESS reading, and the card draws the header with no facts in it rather
    // than a true half of the truth.
    //
    // It also keeps the floor honest: the floor line's `package` half is read off
    // the headers the card was given, and a package inferred from the readable
    // half of a two-package gate is exactly the invented value "never a raw error
    // or manifest value" was written to keep off that line.
    readReviewGate.mockResolvedValue(
      gate([
        { artifactId: "art-1", representationRevisionId: "rev_1" },
        { artifactId: "art-2", representationRevisionId: "rev_2" },
      ]),
    );
    readArtifactForDetail
      .mockReturnValueOnce(artifact())
      .mockReturnValueOnce({ kind: "not-found" });

    expect(await read(PENDING)).toBeNull();
  });

  it("and still names every target of a gate it CAN open whole", async () => {
    // The control: the refusal above is the unreadable row's doing and not the
    // second target's. Two readable rows compose two headers.
    readReviewGate.mockResolvedValue(
      gate([
        { artifactId: "art-1", representationRevisionId: "rev_1" },
        { artifactId: "art-2", representationRevisionId: "rev_2" },
      ]),
    );
    readArtifactForDetail.mockReturnValue(artifact());

    const headers = await read(PENDING);
    expect(headers).toHaveLength(2);
    expect(lifecycleTargetHeadersSchema.safeParse(headers).success).toBe(true);
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

  it("composes up to the wire's ceiling, and every one of them", async () => {
    readReviewGate.mockResolvedValue(
      gate(
        Array.from({ length: LIFECYCLE_TARGET_HEADERS_MAX }, (_, i) => ({
          artifactId: `art-${i}`,
          representationRevisionId: `rev_${i}`,
        })),
      ),
    );
    const headers = await read(PENDING);
    expect(headers).toHaveLength(LIFECYCLE_TARGET_HEADERS_MAX);
    expect(lifecycleTargetHeadersSchema.safeParse(headers).success).toBe(true);
  });

  it("a gate PAST that ceiling names NONE of its targets, never the first twelve", async () => {
    // THE WHOLE READING OR THE FACTLESS ONE, at the ceiling exactly as at an
    // unreadable row (cinatra#3058, fix leg 8; the convergence round on the
    // reconciled merge). §IV says "Every target opens with a header that names
    // what is under review and fixes it in place" — EVERY target. The card
    // draws this gate's whole pinned set through ONE island under the headers
    // composed here, so a set cut off at the ceiling does not name a set short
    // by four: it tells the reader they are deciding about twelve artifacts
    // when they are deciding about sixteen. It would also make §V's floor lie,
    // because the card names the floor's `package` half only where one name is
    // true of the whole island and would be reading that name off a prefix.
    //
    // This suite used to pin the truncation, back when an unreadable row was
    // skipped too and a partial reading was this composer's rule throughout.
    // It is retired by the sentence above, and by the card's own answer to it:
    // an answer that carries no header draws §IV's header with NO facts in it,
    // which names the READING truthfully instead of naming twelve artifacts.
    readReviewGate.mockResolvedValue(
      gate(
        Array.from({ length: LIFECYCLE_TARGET_HEADERS_MAX + 4 }, (_, i) => ({
          artifactId: `art-${i}`,
          representationRevisionId: `rev_${i}`,
        })),
      ),
    );
    expect(await read(PENDING)).toBeNull();
    // And it costs the reader no store read it did not need: the ceiling is a
    // property of the gate, answered before any artifact is fetched for it.
    expect(readArtifactForDetail).not.toHaveBeenCalled();
  });

  it("a store that throws costs the header, never the card", async () => {
    readReviewGate.mockRejectedValue(new Error("gate store down"));
    expect(await read(PENDING)).toBeNull();
  });
});
