// cinatra#3272 — the shared approvals source's INLINE REJECT shows the
// membership refusal for the ARTIFACT subject, not only for the memory one.
//
// `mapDecideOutcome` in `promotion-requests.ts` is subject-agnostic: it already
// maps a `not_authorized` outcome to `kind: "forbidden"` carrying the backend's
// message verbatim. What was missing was an artifact reject that ever PRODUCES
// that outcome for a decider who is not a member of the organization. This file
// drives the REAL ladder (with injected data-layer deps — no DB) through the
// REAL artifact adapter and the REAL shared source, so the wording a reviewer
// sees on the feed row is the wording the ladder emits.
import { describe, it, expect, vi, beforeEach } from "vitest";

// Inert Badge — the source's renderer is not under test here.
vi.mock("@/components/ui/badge", () => ({ Badge: () => null }));

const decideArtifactPromotionMock = vi.fn();

// Only `decideArtifactPromotion` is swapped; everything else stays real, so the
// adapter, the row-id discriminator and the outcome mapping are the production
// ones. The swap exists solely to inject the deps the real ladder runs over
// (the exported `decideArtifactPromotion` takes them as a second argument, and
// the adapter — correctly — does not forward one).
vi.mock("@/lib/objects/artifact-row-promotion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/objects/artifact-row-promotion")>();
  return {
    ...actual,
    decideArtifactPromotion: (...args: unknown[]) =>
      decideArtifactPromotionMock(...(args as [])),
  };
});

import { promotionRequestsSource } from "@/lib/approvals/sources/promotion-requests";
import { formatPromotionRowId } from "@/lib/approvals/sources/promotion-subjects";
import type { ApprovalViewer } from "@/lib/approvals/sources/types";
import type {
  ArtifactPromotionDeps,
  ArtifactPromotionRequestRow,
} from "@/lib/objects/artifact-row-promotion";

/** A platform administrator — the PLATFORM role, which says nothing about
 *  membership of `org-1`. */
const platformAdmin: ApprovalViewer = { userId: "u-admin", orgId: "org-1", isAdmin: true };

function pendingRequest(): ArtifactPromotionRequestRow {
  return {
    id: "req-1",
    orgId: "org-1",
    objectId: "obj-1",
    objectTitle: "Quarterly insight",
    requestedBy: "u-member",
    fromVisibility: "private",
    toVisibility: "organization",
    toOwnerLevel: "organization",
    toOwnerId: "org-1",
    toOwnerLabel: null,
    rowVersion: 3,
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
}

/** Injected data-layer deps: the request is pending, and the decider holds no
 *  membership of this organization. */
function nonMemberDeps() {
  const request = pendingRequest();
  const spies = {
    readRequestById: vi.fn(() => request),
    listRequests: vi.fn(() => [request]),
    countRequests: vi.fn(() => 1),
    casDecideRequest: vi.fn(() => ({ ok: true }) as const),
    markSuperseded: vi.fn(() => true),
    compensateApproved: vi.fn(() => true),
    createRequest: vi.fn(() => request),
    readObject: vi.fn(() => null),
    readTeamInOrg: vi.fn(() => null),
    widenAndReproject: vi.fn(async () => ({ ok: true }) as const),
    scanContent: vi.fn(() => ({ clean: true })),
    isDeciderAMember: vi.fn(async () => false),
  };
  return { deps: spies as unknown as ArtifactPromotionDeps, spies };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the shared approvals source's inline reject — artifact subject", () => {
  it("shows the membership refusal to a platform administrator who is not a member", async () => {
    const actual = await vi.importActual<typeof import("@/lib/objects/artifact-row-promotion")>(
      "@/lib/objects/artifact-row-promotion",
    );
    const { deps, spies } = nonMemberDeps();
    decideArtifactPromotionMock.mockImplementation((args: Parameters<typeof actual.decideArtifactPromotion>[0]) =>
      actual.decideArtifactPromotion(args, deps),
    );

    const result = await promotionRequestsSource.actions.decide(
      {
        rowId: formatPromotionRowId("artifact", "req-1"),
        action: "reject",
        reason: "not relevant to the organization",
      },
      platformAdmin,
    );

    expect(result).toEqual({
      ok: false,
      kind: "forbidden",
      code: "not_authorized",
      message:
        "You are not a member of this organization, so you cannot decide this promotion request.",
    });
    // Nothing was written: the request keeps its pending decision fields.
    expect(spies.casDecideRequest).not.toHaveBeenCalled();
  });

  it("settles the reject for a decider who IS a member (unchanged behaviour)", async () => {
    const actual = await vi.importActual<typeof import("@/lib/objects/artifact-row-promotion")>(
      "@/lib/objects/artifact-row-promotion",
    );
    const { deps, spies } = nonMemberDeps();
    spies.isDeciderAMember.mockImplementation(async () => true);
    decideArtifactPromotionMock.mockImplementation((args: Parameters<typeof actual.decideArtifactPromotion>[0]) =>
      actual.decideArtifactPromotion(args, deps),
    );

    const result = await promotionRequestsSource.actions.decide(
      {
        rowId: formatPromotionRowId("artifact", "req-1"),
        action: "reject",
        reason: "not relevant to the organization",
      },
      platformAdmin,
    );

    expect(result).toEqual({ ok: true });
    expect(spies.casDecideRequest).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "reject", requireMemberUserId: "u-admin" }),
    );
  });
});
