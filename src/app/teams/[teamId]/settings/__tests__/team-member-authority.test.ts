/**
 * canManageTeamMembers — the named interim authority predicate for team
 * membership management (cinatra#1567, pending the #1566 role model).
 *
 * Truths locked here:
 *  - platform admin passes regardless of org role (independent authority);
 *  - org_owner / org_admin of the team's org pass;
 *  - plain `member`, no membership (`undefined`), and unknown role strings
 *    all fail CLOSED — the same allowlist stance as the team-visibility
 *    widening (`TEAM_WIDENING_ORG_ROLES`).
 */
import { describe, expect, it } from "vitest";

import {
  TEAM_MEMBER_MANAGING_ORG_ROLES,
  canManageTeamMembers,
} from "../team-member-authority";

describe("canManageTeamMembers", () => {
  it("grants a platform admin regardless of org role", () => {
    expect(
      canManageTeamMembers({ platformAdmin: true, orgRole: undefined }),
    ).toBe(true);
    expect(canManageTeamMembers({ platformAdmin: true, orgRole: "member" })).toBe(
      true,
    );
  });

  it("grants org_owner and org_admin of the team's org", () => {
    expect(
      canManageTeamMembers({ platformAdmin: false, orgRole: "org_owner" }),
    ).toBe(true);
    expect(
      canManageTeamMembers({ platformAdmin: false, orgRole: "org_admin" }),
    ).toBe(true);
  });

  it("fails closed for member / no membership / unknown roles", () => {
    expect(canManageTeamMembers({ platformAdmin: false, orgRole: "member" })).toBe(
      false,
    );
    expect(
      canManageTeamMembers({ platformAdmin: false, orgRole: undefined }),
    ).toBe(false);
    expect(
      canManageTeamMembers({
        platformAdmin: false,
        // an unknown role string must not widen (fail closed)
        orgRole: "superuser" as unknown as "member",
      }),
    ).toBe(false);
  });

  it("keeps the managing-role allowlist aligned with the team-visibility widening", () => {
    // Mirror of TEAM_WIDENING_ORG_ROLES (packages/dashboards/src/auth/
    // team-visibility.ts) — kept local to the app route by design; this
    // pins the alignment so a drift is caught.
    expect([...TEAM_MEMBER_MANAGING_ORG_ROLES].sort()).toEqual([
      "org_admin",
      "org_owner",
    ]);
  });
});
