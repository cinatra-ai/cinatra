// cinatra#1433 — the dynamic-type artifact-visibility ApprovalSource: the
// admin + approve-only decide gates (each short-circuiting BEFORE the
// backend), viewer-org confinement (decide always targets the authenticated
// viewer's org — the row id carries only the type id), the empty
// "Your requests" envelope, and the Inbox row mapping/rendering. The approval
// backend is mocked (its own ladder is proven in
// artifact-visibility-approval.test.ts).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const approveDynamicTypeArtifactVisibility = vi.fn();
const listDynamicTypeVisibilityReviewRows = vi.fn();
const countUnapprovedDynamicTypes = vi.fn(async () => 0);
vi.mock("@/lib/objects/artifact-visibility-approval", () => ({
  approveDynamicTypeArtifactVisibility: (...a: unknown[]) =>
    approveDynamicTypeArtifactVisibility(...(a as [])),
  listDynamicTypeVisibilityReviewRows: (...a: unknown[]) =>
    listDynamicTypeVisibilityReviewRows(...(a as [])),
  countUnapprovedDynamicTypes: (...a: unknown[]) => countUnapprovedDynamicTypes(...(a as [])),
  // Real predicate (pure) — the inbox filter under test depends on it.
  approvalAwaitsDecision: (approval: { status?: string } | null) =>
    approval == null || approval.status === "reserved",
}));

// Stub the client component + Badge to inert nodes — the row-render assertions
// exercise the plain title/type text the source itself emits.
vi.mock("../../dynamic-type-visibility-decision-actions", () => ({
  DynamicTypeVisibilityDecisionActions: () => null,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: () => null,
}));

import { dynamicTypeArtifactVisibilitySource } from "../dynamic-type-artifact-visibility";
import { DYNAMIC_TYPE_VISIBILITY_SOURCE_ID } from "../dynamic-type-artifact-visibility.contract";
import type { DynamicTypeVisibilityReviewRow } from "@/lib/objects/artifact-visibility-approval";
import type { ApprovalViewer } from "../types";

const admin: ApprovalViewer = { userId: "u-admin", orgId: "org-1", isAdmin: true };
const member: ApprovalViewer = { userId: "u-member", orgId: "org-1", isAdmin: false };

const TYPE = "@cinatra-ai/dynamic:competitor-profile";

function reviewRow(over: Partial<DynamicTypeVisibilityReviewRow> = {}): DynamicTypeVisibilityReviewRow {
  return {
    objectTypeId: TYPE,
    displayName: "Competitor profile",
    category: "profile",
    mintedBy: "mcp",
    createdAt: "2026-07-13T00:00:00.000Z",
    approval: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("direction gating", () => {
  it("Inbox is admin-only; there is no 'Your requests' view", () => {
    expect(dynamicTypeArtifactVisibilitySource.appliesTo(admin, "inbox")).toBe(true);
    expect(dynamicTypeArtifactVisibilitySource.appliesTo(member, "inbox")).toBe(false);
    expect(dynamicTypeArtifactVisibilitySource.appliesTo(admin, "mine")).toBe(false);
  });

  it("fetchMine is an empty ready envelope (defense in depth)", async () => {
    const env = await dynamicTypeArtifactVisibilitySource.fetchMine(admin);
    expect(env.availability).toBe("ready");
    expect(env.rows).toEqual([]);
    expect(listDynamicTypeVisibilityReviewRows).not.toHaveBeenCalled();
  });

  it("fetchInbox for a non-admin returns empty WITHOUT touching the backend", async () => {
    const env = await dynamicTypeArtifactVisibilitySource.fetchInbox(member);
    expect(env.rows).toEqual([]);
    expect(listDynamicTypeVisibilityReviewRows).not.toHaveBeenCalled();
  });

  it("counts report 0 for a non-admin without a backend read", async () => {
    expect(await dynamicTypeArtifactVisibilitySource.counts(member)).toEqual({ inbox: 0, mine: 0 });
    expect(countUnapprovedDynamicTypes).not.toHaveBeenCalled();
    countUnapprovedDynamicTypes.mockResolvedValueOnce(3);
    expect(await dynamicTypeArtifactVisibilitySource.counts(admin)).toEqual({ inbox: 3, mine: 0 });
    expect(countUnapprovedDynamicTypes).toHaveBeenCalledWith({ orgId: "org-1" });
  });
});

describe("fetchInbox row mapping", () => {
  it("surfaces only UNAPPROVED active dynamic types; the type id is the row id", async () => {
    listDynamicTypeVisibilityReviewRows.mockResolvedValueOnce([
      reviewRow(),
      reviewRow({
        objectTypeId: "@cinatra-ai/dynamic:already-covered",
        approval: {
          orgId: "org-1",
          objectTypeId: "@cinatra-ai/dynamic:already-covered",
          claimId: "c1",
          status: "active",
          generation: 1,
          approvedAt: "2026-07-13T00:00:00.000Z",
        },
      }),
    ]);
    const env = await dynamicTypeArtifactVisibilitySource.fetchInbox(admin);
    expect(listDynamicTypeVisibilityReviewRows).toHaveBeenCalledWith({ orgId: "org-1" });
    expect(env.rows).toHaveLength(1);
    expect(env.rows[0]).toMatchObject({
      id: TYPE,
      sourceId: DYNAMIC_TYPE_VISIBILITY_SOURCE_ID,
      title: "Competitor profile",
      subtitle: TYPE,
      status: "unapproved",
    });
    expect(env.actions).toEqual([
      { id: "approve", label: "Approve coverage", enforcement: "local" },
    ]);
  });

  it("a stranded 'reserved' approval stays IN the Inbox (actionable — re-deciding self-heals)", async () => {
    listDynamicTypeVisibilityReviewRows.mockResolvedValueOnce([
      reviewRow({
        approval: {
          orgId: "org-1",
          objectTypeId: TYPE,
          claimId: "c-reserved",
          status: "reserved",
          generation: 1,
          approvedAt: "2026-07-13T00:00:00.000Z",
        },
      }),
    ]);
    const env = await dynamicTypeArtifactVisibilitySource.fetchInbox(admin);
    expect(env.rows).toHaveLength(1);
    expect(env.rows[0]).toMatchObject({ id: TYPE, status: "reserved" });
  });

  it("rowRenderer emits the display name, type id and category (smoke)", async () => {
    listDynamicTypeVisibilityReviewRows.mockResolvedValueOnce([reviewRow()]);
    const env = await dynamicTypeArtifactVisibilitySource.fetchInbox(admin);
    const html = renderToStaticMarkup(
      dynamicTypeArtifactVisibilitySource.rowRenderer(env.rows[0], { direction: "inbox" }) as never,
    );
    expect(html).toContain("Competitor profile");
    expect(html).toContain(TYPE);
    expect(html).toContain("profile");
    expect(html).toContain("minted by mcp");
  });
});

describe("decide gates (each short-circuits BEFORE the backend)", () => {
  it("refuses a non-admin as forbidden", async () => {
    const res = await dynamicTypeArtifactVisibilitySource.actions.decide(
      { rowId: TYPE, action: "approve" },
      member,
    );
    expect(res).toMatchObject({ ok: false, kind: "forbidden", code: "not_admin" });
    expect(approveDynamicTypeArtifactVisibility).not.toHaveBeenCalled();
  });

  it("is approve-only: any other action refuses", async () => {
    const res = await dynamicTypeArtifactVisibilitySource.actions.decide(
      { rowId: TYPE, action: "reject", reason: "nope" },
      admin,
    );
    expect(res).toMatchObject({ ok: false, kind: "refused", code: "unknown_action" });
    expect(approveDynamicTypeArtifactVisibility).not.toHaveBeenCalled();
  });

  it("refuses a blank row id as not_found", async () => {
    const res = await dynamicTypeArtifactVisibilitySource.actions.decide(
      { rowId: "   ", action: "approve" },
      admin,
    );
    expect(res).toMatchObject({ ok: false, kind: "refused", code: "not_found" });
    expect(approveDynamicTypeArtifactVisibility).not.toHaveBeenCalled();
  });

  it("targets the AUTHENTICATED viewer's org — never a caller-named scope", async () => {
    approveDynamicTypeArtifactVisibility.mockResolvedValueOnce({
      ok: true,
      claimId: "c-new",
      repairedReservedClaim: false,
    });
    const res = await dynamicTypeArtifactVisibilitySource.actions.decide(
      { rowId: TYPE, action: "approve" },
      admin,
    );
    expect(res).toEqual({ ok: true });
    expect(approveDynamicTypeArtifactVisibility).toHaveBeenCalledWith({
      orgId: "org-1",
      objectTypeId: TYPE,
      approvedBy: "u-admin",
    });
  });

  it.each([
    ["not_found", "refused", "not_found"],
    ["not_active", "refused", "invalid_state"],
    ["already_approved", "refused", "invalid_state"],
    ["claim_conflict", "refused", "conflict"],
  ] as const)("maps backend '%s' onto (%s, %s)", async (code, kind, mapped) => {
    approveDynamicTypeArtifactVisibility.mockResolvedValueOnce({
      ok: false,
      code,
      message: `m-${code}`,
    });
    const res = await dynamicTypeArtifactVisibilitySource.actions.decide(
      { rowId: TYPE, action: "approve" },
      admin,
    );
    expect(res).toMatchObject({ ok: false, kind, code: mapped, message: `m-${code}` });
  });
});
