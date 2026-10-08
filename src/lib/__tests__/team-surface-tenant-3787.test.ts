// cinatra#3787: a team surface resolves its tenant from the TEAM, not from the
// session's active organization.
//
// The landing, the name read and the dashboard actions all took the same
// decision three times, and one of them took it wrong: the landing compared the
// session's ACTIVE organization with the team's and refused whenever the two
// differed, ahead of its own member-or-manager gate. A platform admin who owns
// every organization therefore met "This area is limited to platform admins" on
// a team they administer.
//
// The decision is now ONE pure function, so the page, the actions and the name
// read cannot drift apart, and each of its cases is testable with no database.
// Every case below holds the active organization DIFFERENT from the team's.
import { describe, expect, it } from "vitest";

import {
  resolveTeamSurfaceAccess,
  TEAM_SURFACE_REFUSAL_REASON,
} from "@/lib/team-surface-access";

const TEAM = { organizationId: "org_team" } as const;

describe("a team surface's gate reads the team's own organization", () => {
  it("admits the platform admin, whatever organization is active", () => {
    expect(
      resolveTeamSurfaceAccess({
        team: TEAM,
        isMember: false,
        platformAdmin: true,
        orgRole: undefined,
      }),
    ).toEqual({ outcome: "allowed", canManage: true });
  });

  it("admits a team admin of the team", () => {
    expect(
      resolveTeamSurfaceAccess({
        team: TEAM,
        isMember: true,
        platformAdmin: false,
        orgRole: undefined,
        teamRole: "admin",
      }),
    ).toEqual({ outcome: "allowed", canManage: true });
  });

  it("admits an owner of the TEAM's organization who is not on the team", () => {
    expect(
      resolveTeamSurfaceAccess({
        team: TEAM,
        isMember: false,
        platformAdmin: false,
        orgRole: "org_owner",
      }),
    ).toEqual({ outcome: "allowed", canManage: true });
  });

  it("admits an admin of the TEAM's organization who is not on the team", () => {
    expect(
      resolveTeamSurfaceAccess({
        team: TEAM,
        isMember: false,
        platformAdmin: false,
        orgRole: "org_admin",
      }),
    ).toEqual({ outcome: "allowed", canManage: true });
  });

  it("admits a plain member of the team, who manages nothing", () => {
    expect(
      resolveTeamSurfaceAccess({
        team: TEAM,
        isMember: true,
        platformAdmin: false,
        orgRole: "member",
        teamRole: "member",
      }),
    ).toEqual({ outcome: "allowed", canManage: false });
  });

  it("refuses a member of the team's organization who is not on the team, naming the reason", () => {
    expect(
      resolveTeamSurfaceAccess({
        team: TEAM,
        isMember: false,
        platformAdmin: false,
        orgRole: "member",
      }),
    ).toEqual({ outcome: "refused", reason: TEAM_SURFACE_REFUSAL_REASON });
  });

  it("refuses a caller with no role at all, naming the same reason", () => {
    expect(
      resolveTeamSurfaceAccess({
        team: TEAM,
        isMember: false,
        platformAdmin: false,
        orgRole: undefined,
      }),
    ).toEqual({ outcome: "refused", reason: "scope-membership" });
  });

  it("reports an unknown team as not found, before any authority question", () => {
    expect(
      resolveTeamSurfaceAccess({
        team: null,
        isMember: false,
        platformAdmin: true,
        orgRole: "org_owner",
      }),
    ).toEqual({ outcome: "not-found" });
  });
});
