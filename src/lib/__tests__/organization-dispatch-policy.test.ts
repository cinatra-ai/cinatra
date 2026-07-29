/**
 * Pure decision logic for the Better-Auth dispatch-hook endpoint policy
 * (cinatra#1942 archive V2, Decision 5, mechanism 3) — no I/O, no live
 * `betterAuth()` instance. The dual-transport hook-CONTRACT test (proving
 * these decisions actually reach real Better-Auth requests on both
 * transports) lives in `organization-dispatch-policy-hooks.test.ts`.
 *
 * Truths locked here:
 *  - the endpoint classification is exactly the design's allow/prohibit map;
 *  - SPLIT read-error polarity (codex r0 finding #6): a PROHIBITED endpoint
 *    refuses on an unknown (failed-read) archived state; a CLEANUP endpoint
 *    still allows;
 *  - an endpoint outside both lists is "not-policed" regardless of state;
 *  - org-id resolution tries organizationId -> teamId lookup ->
 *    invitationId lookup -> active-org fallback, in that order, and never
 *    throws on a failing sub-lookup (falls through instead).
 */
import { describe, expect, it, vi } from "vitest";
import {
  ARCHIVED_CLEANUP_ENDPOINTS,
  ARCHIVED_PROHIBITED_ENDPOINTS,
  decideDispatchPolicy,
  extractOrganizationListPayload,
  filterArchivedOrganizations,
  resolveDispatchTargetOrganizationId,
} from "../organization-dispatch-policy";

describe("decideDispatchPolicy", () => {
  it("is not-policed for an endpoint outside both lists, regardless of archived state", () => {
    expect(decideDispatchPolicy("/organization/create", true)).toBe("not-policed");
    expect(decideDispatchPolicy("/organization/create", false)).toBe("not-policed");
    expect(decideDispatchPolicy("/organization/create", "unknown")).toBe("not-policed");
  });

  it("allows every policed endpoint when the org is active", () => {
    for (const path of [...ARCHIVED_PROHIBITED_ENDPOINTS, ...ARCHIVED_CLEANUP_ENDPOINTS]) {
      expect(decideDispatchPolicy(path, false)).toBe("allow");
    }
  });

  describe("archived === true", () => {
    it("refuses every PROHIBITED endpoint", () => {
      for (const path of ARCHIVED_PROHIBITED_ENDPOINTS) {
        expect(decideDispatchPolicy(path, true)).toBe("refuse");
      }
    });
    it("allows every CLEANUP endpoint", () => {
      for (const path of ARCHIVED_CLEANUP_ENDPOINTS) {
        expect(decideDispatchPolicy(path, true)).toBe("allow");
      }
    });
  });

  describe("archived === 'unknown' (a forced archivedAt-read failure) — SPLIT polarity (codex r0 #6)", () => {
    it("PROHIBITED endpoints fail CLOSED (refuse) — no downstream fence exists pre-Stage-E", () => {
      for (const path of ARCHIVED_PROHIBITED_ENDPOINTS) {
        expect(decideDispatchPolicy(path, "unknown")).toBe("refuse");
      }
    });
    it("CLEANUP endpoints fail OPEN (allow) — a user must never be trapped in an archived org", () => {
      for (const path of ARCHIVED_CLEANUP_ENDPOINTS) {
        expect(decideDispatchPolicy(path, "unknown")).toBe("allow");
      }
    });
  });

  it("the prohibit and cleanup lists are exactly the design's map (Decision 5)", () => {
    expect([...ARCHIVED_PROHIBITED_ENDPOINTS].sort()).toEqual(
      [
        "/organization/accept-invitation",
        "/organization/add-team-member",
        "/organization/remove-team-member",
        "/organization/set-active",
        "/organization/set-active-team",
      ].sort(),
    );
    expect([...ARCHIVED_CLEANUP_ENDPOINTS].sort()).toEqual(
      [
        "/organization/cancel-invitation",
        "/organization/leave",
        "/organization/reject-invitation",
      ].sort(),
    );
  });
});

describe("resolveDispatchTargetOrganizationId", () => {
  const deps = () => ({
    readTeamOrganizationId: vi.fn(async (_teamId: string) => null as string | null),
    readInvitationOrganizationId: vi.fn(async (_invitationId: string) => null as string | null),
  });

  it("prefers an explicit body.organizationId over everything else", async () => {
    const d = deps();
    const orgId = await resolveDispatchTargetOrganizationId(
      { path: "/organization/set-active", body: { organizationId: "org-explicit", teamId: "team-1" } },
      d,
    );
    expect(orgId).toBe("org-explicit");
    expect(d.readTeamOrganizationId).not.toHaveBeenCalled();
  });

  it("resolves via body.teamId when no explicit organizationId is present", async () => {
    const d = deps();
    d.readTeamOrganizationId.mockResolvedValue("org-of-team");
    const orgId = await resolveDispatchTargetOrganizationId(
      { path: "/organization/add-team-member", body: { teamId: "team-1", userId: "u-1" } },
      d,
    );
    expect(orgId).toBe("org-of-team");
    expect(d.readTeamOrganizationId).toHaveBeenCalledWith("team-1");
  });

  it("resolves via body.invitationId when no organizationId/teamId is present", async () => {
    const d = deps();
    d.readInvitationOrganizationId.mockResolvedValue("org-of-invite");
    const orgId = await resolveDispatchTargetOrganizationId(
      { path: "/organization/cancel-invitation", body: { invitationId: "inv-1" } },
      d,
    );
    expect(orgId).toBe("org-of-invite");
  });

  it("falls back to the caller's active organization when body carries no id at all", async () => {
    const d = deps();
    const orgId = await resolveDispatchTargetOrganizationId(
      { path: "/organization/leave", body: {}, activeOrganizationId: "org-active" },
      d,
    );
    expect(orgId).toBe("org-active");
  });

  it("returns null (un-policeable) when nothing resolves — never guesses", async () => {
    const d = deps();
    const orgId = await resolveDispatchTargetOrganizationId(
      { path: "/organization/leave", body: {}, activeOrganizationId: null },
      d,
    );
    expect(orgId).toBeNull();
  });

  it("falls through to the active-org fallback when the teamId lookup throws (never crashes the hook)", async () => {
    const d = deps();
    d.readTeamOrganizationId.mockRejectedValue(new Error("db down"));
    const orgId = await resolveDispatchTargetOrganizationId(
      { path: "/organization/set-active-team", body: { teamId: "team-1" }, activeOrganizationId: "org-fallback" },
      d,
    );
    expect(orgId).toBe("org-fallback");
  });

  it("falls through to the active-org fallback when the invitationId lookup throws", async () => {
    const d = deps();
    d.readInvitationOrganizationId.mockRejectedValue(new Error("db down"));
    const orgId = await resolveDispatchTargetOrganizationId(
      { path: "/organization/accept-invitation", body: { invitationId: "inv-1" }, activeOrganizationId: "org-fallback" },
      d,
    );
    expect(orgId).toBe("org-fallback");
  });

  it("ignores a blank-string organizationId and falls through", async () => {
    const d = deps();
    d.readTeamOrganizationId.mockResolvedValue("org-of-team");
    const orgId = await resolveDispatchTargetOrganizationId(
      { path: "/organization/add-team-member", body: { organizationId: "", teamId: "team-1" } },
      d,
    );
    expect(orgId).toBe("org-of-team");
  });
});

describe("filterArchivedOrganizations", () => {
  it("keeps rows with archivedAt null or undefined, drops rows with a set archivedAt", () => {
    const rows = [
      { id: "a", archivedAt: null },
      { id: "b", archivedAt: undefined },
      { id: "c" }, // no archivedAt key at all
      { id: "d", archivedAt: new Date().toISOString() },
    ];
    const kept = filterArchivedOrganizations(rows).map((r) => r.id);
    expect(kept).toEqual(["a", "b", "c"]);
  });

  it("is a no-op on an all-active list", () => {
    const rows = [{ id: "a", archivedAt: null }];
    expect(filterArchivedOrganizations(rows)).toEqual(rows);
  });
});

describe("extractOrganizationListPayload", () => {
  it("passes through a bare array (the documented Better-Auth listOrganizations shape)", () => {
    const rows = [{ id: "a" }];
    expect(extractOrganizationListPayload(rows)).toBe(rows);
  });

  it("unwraps a {organizations: [...]} envelope defensively", () => {
    const rows = [{ id: "a" }];
    expect(extractOrganizationListPayload({ organizations: rows })).toBe(rows);
  });

  it("returns null for an unrecognized shape — the after-hook must fail OPEN on this, never throw", () => {
    expect(extractOrganizationListPayload(null)).toBeNull();
    expect(extractOrganizationListPayload(undefined)).toBeNull();
    expect(extractOrganizationListPayload({ notOrganizations: [] })).toBeNull();
    expect(extractOrganizationListPayload("unexpected string")).toBeNull();
  });
});
