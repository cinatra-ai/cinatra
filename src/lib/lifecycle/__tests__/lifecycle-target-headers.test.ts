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

const actorContext = vi.fn((): Record<string, unknown> => ({ actor: "actor" }));
vi.mock("@/lib/authz/build-actor-context", () => ({
  buildActorContextFromPrimitive: () => actorContext(),
}));

const readOwnerDisplayName = vi.fn();
vi.mock("@/lib/owner-display-names", () => ({
  readOwnerDisplayName: (...args: unknown[]) => readOwnerDisplayName(...args),
}));

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import {
  LIFECYCLE_TARGET_HEADERS_MAX,
  LIFECYCLE_TARGET_HEADER_MAX_TEXT,
  lifecycleTargetHeadersSchema,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

import { encodeLifecycleGateRef } from "../lifecycle-card-ref";
import { readReviewTargetHeaders, readReviewTargetHeadersReading } from "../lifecycle-target-headers";

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
  readOwnerDisplayName.mockResolvedValue(null);
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

describe("the meta line names each scope by its type and its name (cinatra#3443)", () => {
  const NAMES: Record<string, string> = { "team:team-1": "Growth", "organization:org-1": "Acme Corp" };
  beforeEach(() => {
    readOwnerDisplayName.mockImplementation(async (level: string, id: string) => NAMES[`${level}:${id}`] ?? null);
    // The reader belongs to org-1 and to team-1.
    actorContext.mockReturnValue({ actor: "actor", organizationId: "org-1", teamIds: ["team-1"] });
  });

  it("a team's private artifact reads Team: Growth · Private", async () => {
    readArtifactForDetail.mockReturnValue(artifact({ ownerId: "team-1", organizationId: "org-1" }));
    const headers = await read(PENDING);
    expect(headers![0]!.facts.slice(0, 2)).toEqual(["Team: Growth", "Private"]);
    expect(readOwnerDisplayName).toHaveBeenCalledWith("team", "team-1");
  });

  it("an organization's artifact visible to its organization names the organization once", async () => {
    readArtifactForDetail.mockReturnValue(
      artifact({ ownerLevel: "organization", visibility: "organization", ownerId: null, organizationId: "org-1" }),
    );
    const headers = await read(PENDING);
    expect(headers![0]!.facts).toHaveLength(3);
    expect(headers![0]!.facts[0]).toBe("Organization: Acme Corp");
    expect(headers![0]!.facts[1]).toBe("text/html");
  });

  it("a team's artifact visible to its organization names both scopes", async () => {
    readArtifactForSettledReview.mockReturnValue(
      artifact({ visibility: "organization", ownerId: "team-1", organizationId: "org-1" }),
    );
    const headers = await read(SETTLED_DECIDED);
    expect(headers![0]!.facts.slice(0, 2)).toEqual(["Team: Growth", "Organization: Acme Corp"]);
  });

  it("a team the reader does not belong to is drawn by its type alone, and its name is never read", async () => {
    readArtifactForDetail.mockReturnValue(
      artifact({ visibility: "organization", ownerId: "team-2", organizationId: "org-1" }),
    );
    const headers = await read(PENDING);
    expect(headers![0]!.facts.slice(0, 2)).toEqual(["Team", "Organization: Acme Corp"]);
    expect(readOwnerDisplayName).not.toHaveBeenCalledWith("team", "team-2");
  });

  it("an organization other than the reader's is drawn by its type alone, once, and its name is never read", async () => {
    readArtifactForSettledReview.mockReturnValue(
      artifact({ ownerLevel: "organization", visibility: "organization", ownerId: null, organizationId: "org-2" }),
    );
    const headers = await read(SETTLED_DECIDED);
    expect(headers![0]!.facts).toHaveLength(3);
    expect(headers![0]!.facts[0]).toBe("Organization");
    expect(readOwnerDisplayName).not.toHaveBeenCalled();
  });

  it("a reader whose memberships did not resolve names no scope at all", async () => {
    actorContext.mockReturnValue({ actor: "actor" });
    readArtifactForDetail.mockReturnValue(artifact({ visibility: "organization", ownerId: "team-1", organizationId: "org-1" }));
    const headers = await read(PENDING);
    expect(headers![0]!.facts.slice(0, 2)).toEqual(["Team", "Organization"]);
    expect(readOwnerDisplayName).not.toHaveBeenCalled();
  });

  it("a name that does not resolve floors to the type word and still draws the header", async () => {
    actorContext.mockReturnValue({ actor: "actor", organizationId: "org-1", teamIds: ["team-gone"] });
    readArtifactForDetail.mockReturnValue(artifact({ ownerId: "team-gone", organizationId: "org-1" }));
    const headers = await read(PENDING);
    expect(headers![0]!.facts.slice(0, 2)).toEqual(["Team", "Private"]);
    expect(lifecycleTargetHeadersSchema.safeParse(headers).success).toBe(true);
  });
});

describe("the reading says whether the headers are the gate's WHOLE pinned set", () => {
  const pins = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      artifactId: `art-${i + 1}`,
      representationRevisionId: `rev_${i + 1}`,
    }));
  const reading = (state: LifecycleCardState = PENDING) =>
    readReviewTargetHeadersReading({
      viewType: "artifact_review_gate",
      ref: REF,
      state,
      actorCtx: ACTOR,
    });

  it("a gate whose every pinned target this reader may read is complete", async () => {
    readReviewGate.mockResolvedValue(gate(pins(3)));
    const read = await reading();
    expect(read.headers).toHaveLength(3);
    expect(read.pinnedCount).toBe(3);
    expect(read.complete).toBe(true);
  });

  it("a THREE-target gate with one target this reader cannot read is NOT complete", async () => {
    readReviewGate.mockResolvedValue(gate(pins(3)));
    readArtifactForDetail.mockImplementation(({ artifactId }: { artifactId: string }) =>
      artifactId === "art-2" ? { kind: "not-found" } : artifact({ artifactId, title: artifactId }),
    );
    const read = await reading();
    expect(read.headers?.map((header) => header.revisionId)).toEqual(["rev_1", "rev_3"]);
    expect(read.pinnedCount).toBe(3);
    expect(read.complete).toBe(false);
  });

  it("a SIXTEEN-target gate is cut at the bound and is NOT complete", async () => {
    readReviewGate.mockResolvedValue(gate(pins(16)));
    const read = await reading();
    expect(read.headers).toHaveLength(LIFECYCLE_TARGET_HEADERS_MAX);
    expect(read.pinnedCount).toBe(16);
    expect(read.complete).toBe(false);
  });

  it("a settled gate is read the same way", async () => {
    readReviewGate.mockResolvedValue(gate(pins(2)));
    readArtifactForSettledReview.mockReturnValueOnce({ kind: "not-found" });
    const read = await reading(SETTLED_DECIDED);
    expect(read.headers).toHaveLength(1);
    expect(read.complete).toBe(false);
  });

  it("no headers, a refused state and a store that throws are never complete", async () => {
    readArtifactForDetail.mockReturnValue({ kind: "not-found" });
    expect(await reading()).toEqual({ headers: null, pinnedCount: 1, complete: false });
    expect(await reading({ state: "absent" })).toEqual({ headers: null, pinnedCount: 0, complete: false });
    readReviewGate.mockRejectedValue(new Error("gate store down"));
    expect(await reading()).toEqual({ headers: null, pinnedCount: 0, complete: false });
  });

  it("the headers-only reader answers exactly the reading's headers", async () => {
    readReviewGate.mockResolvedValue(gate(pins(16)));
    expect(await read(PENDING)).toEqual((await reading()).headers);
  });

  // cinatra#4129: a header's revision is the pinned id EXACTLY, or the reading
  // is not the whole pinned set. An id the review target's projection module
  // cannot carry (empty, a dot segment, ill-formed text) or cuts (past the
  // header's text bound) still names its target, and the gate then keeps its
  // ONE aggregate island: no pair, key or address is made from it. What the
  // header shows is always well-formed: a lone surrogate shows as U+FFFD, and
  // a cut never splits an astral character.
  for (const [name, revisionId, shown] of [
    ["an EMPTY revision id", "", "—"],
    ["the dot segment `.`", ".", "."],
    ["the dot segment `..`", "..", ".."],
    ["a lone surrogate", "rev_\uD800", "rev_\uFFFD"],
    [
      "an id past the header's text bound",
      "r".repeat(LIFECYCLE_TARGET_HEADER_MAX_TEXT + 1),
      "r".repeat(LIFECYCLE_TARGET_HEADER_MAX_TEXT),
    ],
    [
      "an astral character across the header's text bound",
      `${"r".repeat(LIFECYCLE_TARGET_HEADER_MAX_TEXT - 1)}😀`,
      "r".repeat(LIFECYCLE_TARGET_HEADER_MAX_TEXT - 1),
    ],
  ] as const) {
    it(`${name} names its target and makes the reading NOT complete`, async () => {
      readReviewGate.mockResolvedValue(
        gate([
          { artifactId: "art-1", representationRevisionId: "rev_1" },
          { artifactId: "art-2", representationRevisionId: revisionId },
        ]),
      );
      const read = await reading();
      expect(read.headers?.map((header) => header.revisionId)).toEqual(["rev_1", shown]);
      expect(read.pinnedCount).toBe(2);
      expect(read.complete).toBe(false);
      expect(lifecycleTargetHeadersSchema.safeParse(read.headers).success).toBe(true);
    });
  }

  it("every exact id keeps the reading complete", async () => {
    readReviewGate.mockResolvedValue(
      gate([
        { artifactId: "art-1", representationRevisionId: "rev_1" },
        { artifactId: "art-2", representationRevisionId: "r".repeat(LIFECYCLE_TARGET_HEADER_MAX_TEXT) },
      ]),
    );
    expect((await reading()).complete).toBe(true);
  });
});
