/**
 * Pure decision logic for the Better-Auth dispatch-hook endpoint policy
 * (cinatra#1942 archive V2, Decision 5, mechanism 3) — no I/O, no live
 * `betterAuth()` instance. The dual-transport hook-CONTRACT test (proving
 * these decisions actually reach real Better-Auth requests on both
 * transports) lives in `organization-dispatch-policy-hooks.test.ts`.
 *
 * Truths locked here:
 *  - the endpoint classification is the design's allow/prohibit map PLUS the
 *    V2 adversarial-review extension (codex 1942-v2 r0 #3): the remaining
 *    Better-Auth org mutation endpoints are prohibited too;
 *  - SPLIT read-error polarity (design codex r0 #6): a PROHIBITED endpoint
 *    refuses on an unknown (failed-read) archived state; a CLEANUP endpoint
 *    still allows;
 *  - an endpoint outside both lists is "not-policed" regardless of state;
 *  - target resolution is ENDPOINT-CLASS-AWARE (codex 1942-v2 r0 #1): a
 *    team-target endpoint resolves ONLY via teamId (a caller-planted
 *    organizationId is ignored — the spoof pin), an invitation-target
 *    endpoint ONLY via invitationId, an org-target endpoint via
 *    organizationId / organizationSlug / active-org;
 *  - a resolution lookup ERROR yields {kind:"error"} — never a fallback to
 *    a different org (codex 1942-v2 r0 #2);
 *  - the set-active(null) / set-active-team(null) unset motions are never
 *    policed (the archived-org escape hatch).
 */
import { describe, expect, it, vi } from "vitest";
import {
  ARCHIVED_CLEANUP_ENDPOINTS,
  ARCHIVED_PROHIBITED_ENDPOINTS,
  decideDispatchPolicy,
  ENDPOINT_TARGET_CLASS,
  extractOrganizationListPayload,
  filterArchivedOrganizations,
  resolveDispatchTarget,
} from "../organization-dispatch-policy";

describe("decideDispatchPolicy", () => {
  it("is not-policed for an endpoint outside both lists, regardless of archived state", () => {
    expect(decideDispatchPolicy("/organization/create", true)).toBe("not-policed");
    expect(decideDispatchPolicy("/organization/create", false)).toBe("not-policed");
    expect(decideDispatchPolicy("/organization/create", "unknown")).toBe("not-policed");
    expect(decideDispatchPolicy("/organization/list", true)).toBe("not-policed");
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

  describe("archived === 'unknown' (a failed archivedAt or target read) — SPLIT polarity (codex r0 #6)", () => {
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

  it("the prohibit list is the design's Decision 5 table plus the codex 1942-v2 r0 #3 extension", () => {
    expect([...ARCHIVED_PROHIBITED_ENDPOINTS].sort()).toEqual(
      [
        // Design Decision 5:
        "/organization/accept-invitation",
        "/organization/add-team-member",
        "/organization/remove-team-member",
        "/organization/set-active",
        "/organization/set-active-team",
        // Adversarial-review extension:
        "/organization/add-member",
        "/organization/create-team",
        "/organization/invite-member",
        "/organization/remove-member",
        "/organization/remove-team",
        "/organization/update",
        "/organization/update-member-role",
        "/organization/update-team",
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

  it("every policed endpoint has a target class, and vice versa", () => {
    const policed = new Set([...ARCHIVED_PROHIBITED_ENDPOINTS, ...ARCHIVED_CLEANUP_ENDPOINTS]);
    expect([...policed].sort()).toEqual(Object.keys(ENDPOINT_TARGET_CLASS).sort());
  });
});

describe("resolveDispatchTarget", () => {
  const deps = () => ({
    readTeamOrganizationId: vi.fn(async (_teamId: string) => null as string | null),
    readInvitationOrganizationId: vi.fn(async (_invitationId: string) => null as string | null),
    readOrganizationIdBySlug: vi.fn(async (_slug: string) => null as string | null),
  });

  describe("team-target endpoints (add/remove-team-member, set-active-team, update/remove-team)", () => {
    it("resolves ONLY via teamId — a caller-planted organizationId is IGNORED (codex 1942-v2 r0 #1 spoof pin)", async () => {
      const d = deps();
      d.readTeamOrganizationId.mockResolvedValue("org-archived-A");
      const res = await resolveDispatchTarget(
        "/organization/add-team-member",
        { organizationId: "org-active-B", teamId: "team-of-A", userId: "u-1" },
        "org-active-B",
        d,
      );
      expect(res).toEqual({ kind: "resolved", organizationId: "org-archived-A" });
      expect(d.readTeamOrganizationId).toHaveBeenCalledWith("team-of-A");
    });

    it("a team lookup ERROR is {kind:'error'} — never a fallback to another org (codex 1942-v2 r0 #2)", async () => {
      const d = deps();
      d.readTeamOrganizationId.mockRejectedValue(new Error("db down"));
      const res = await resolveDispatchTarget(
        "/organization/add-team-member",
        { teamId: "team-1" },
        "org-active-fallback",
        d,
      );
      expect(res).toEqual({ kind: "error" });
    });

    it("a missing/blank/null teamId is unresolvable (the endpoint's own validation handles it; null = unset motion)", async () => {
      const d = deps();
      for (const teamId of [undefined, "", null]) {
        const res = await resolveDispatchTarget(
          "/organization/set-active-team",
          { teamId },
          "org-active",
          d,
        );
        expect(res).toEqual({ kind: "unresolvable" });
      }
      expect(d.readTeamOrganizationId).not.toHaveBeenCalled();
    });

    it("a teamId matching no row is unresolvable (the endpoint 404s on its own)", async () => {
      const d = deps();
      const res = await resolveDispatchTarget(
        "/organization/remove-team-member",
        { teamId: "team-ghost" },
        null,
        d,
      );
      expect(res).toEqual({ kind: "unresolvable" });
    });
  });

  describe("invitation-target endpoints (accept/reject/cancel-invitation)", () => {
    it("resolves via invitationId (organizationId in the body is ignored)", async () => {
      const d = deps();
      d.readInvitationOrganizationId.mockResolvedValue("org-of-invite");
      const res = await resolveDispatchTarget(
        "/organization/accept-invitation",
        { invitationId: "inv-1", organizationId: "org-spoof" },
        null,
        d,
      );
      expect(res).toEqual({ kind: "resolved", organizationId: "org-of-invite" });
    });

    it("an invitation lookup ERROR is {kind:'error'}", async () => {
      const d = deps();
      d.readInvitationOrganizationId.mockRejectedValue(new Error("db down"));
      const res = await resolveDispatchTarget(
        "/organization/cancel-invitation",
        { invitationId: "inv-1" },
        "org-active-fallback",
        d,
      );
      expect(res).toEqual({ kind: "error" });
    });
  });

  describe("organization-target endpoints (set-active, leave, invite/remove-member, member-role, add-member, create-team, update)", () => {
    it("resolves an explicit organizationId directly", async () => {
      const d = deps();
      const res = await resolveDispatchTarget(
        "/organization/set-active",
        { organizationId: "org-explicit" },
        "org-active",
        d,
      );
      expect(res).toEqual({ kind: "resolved", organizationId: "org-explicit" });
    });

    it("resolves organizationSlug via the slug lookup when no organizationId is present (the set-active slug leg)", async () => {
      const d = deps();
      d.readOrganizationIdBySlug.mockResolvedValue("org-by-slug");
      const res = await resolveDispatchTarget(
        "/organization/set-active",
        { organizationSlug: "acme" },
        null,
        d,
      );
      expect(res).toEqual({ kind: "resolved", organizationId: "org-by-slug" });
      expect(d.readOrganizationIdBySlug).toHaveBeenCalledWith("acme");
    });

    it("a slug lookup ERROR is {kind:'error'} — not a fallback", async () => {
      const d = deps();
      d.readOrganizationIdBySlug.mockRejectedValue(new Error("db down"));
      const res = await resolveDispatchTarget(
        "/organization/set-active",
        { organizationSlug: "acme" },
        "org-active-fallback",
        d,
      );
      expect(res).toEqual({ kind: "error" });
    });

    it("falls back to the caller's active organization when the body names none (mirrors Better Auth's own default)", async () => {
      const d = deps();
      const res = await resolveDispatchTarget(
        "/organization/invite-member",
        { email: "x@example.test", role: "member" },
        "org-active",
        d,
      );
      expect(res).toEqual({ kind: "resolved", organizationId: "org-active" });
    });

    it("set-active with an explicit organizationId:null (UNSET) is never policed — the archived-org escape hatch", async () => {
      const d = deps();
      const res = await resolveDispatchTarget(
        "/organization/set-active",
        { organizationId: null },
        "org-archived-still-active-in-session",
        d,
      );
      expect(res).toEqual({ kind: "unresolvable" });
    });

    it("is unresolvable when nothing names an org at all", async () => {
      const d = deps();
      const res = await resolveDispatchTarget("/organization/leave", {}, null, d);
      expect(res).toEqual({ kind: "unresolvable" });
    });

    it("ignores a blank-string organizationId and continues down the chain", async () => {
      const d = deps();
      const res = await resolveDispatchTarget(
        "/organization/remove-member",
        { organizationId: "", memberIdOrEmail: "x@example.test" },
        "org-active",
        d,
      );
      expect(res).toEqual({ kind: "resolved", organizationId: "org-active" });
    });
  });

  it("an unmapped path is unresolvable", async () => {
    const d = deps();
    const res = await resolveDispatchTarget("/organization/list", {}, "org-active", d);
    expect(res).toEqual({ kind: "unresolvable" });
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
