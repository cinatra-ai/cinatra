// The ONE shared exact-scope resolver for per-scope assignment writes
// (cinatra#2813 S1, epic #2812).
//
// The epic's authority rule is "whoever writes an assignment must administer
// the scope it affects". This suite is that rule as a MATRIX: one case per
// person class per scope kind, so a widening cannot land quietly.
//
// Two invariants the matrix exists to protect:
//
//   * the resolver reads the EXACT scope, never the kernel's org-widened
//     roles — an org admin of org A administers org A's rows and nothing in
//     org B, and holding `agent.assignments.manage` is not by itself authority
//     over any particular scope;
//   * READS never require write authority — a plain member sees what is
//     assigned to a scope they belong to, and may change none of it.
import { describe, expect, it } from "vitest";

import type { ActorContext } from "@/lib/authz/actor-context";
import { roleHasPermission } from "@/lib/authz/policies";
import { WORKSPACE_SCOPE_SENTINEL } from "@/lib/assignment-scope";
import {
  resolveAssignmentReadAuthority,
  resolveAssignmentWriteAuthority,
} from "@/lib/authz/assignment-authority";

const ORG = "org_1";
const OTHER_ORG = "org_2";
const TEAM = "team_1";
const PROJECT = "proj_1";
const SELF = "user_self";

function actor(over: Partial<ActorContext>): ActorContext {
  return {
    principalId: SELF,
    principalType: "HumanUser",
    authSource: "ui",
    organizationId: ORG,
    teamIds: [],
    teamRoles: {},
    projectGrants: [],
    projectIds: [],
    ...over,
  } as ActorContext;
}

// ── the person classes, named once ────────────────────────────────────────
const orgOwner = actor({ orgRole: "org_owner" });
const orgAdmin = actor({ orgRole: "org_admin" });
const orgMember = actor({ orgRole: "member" });
const teamAdmin = actor({
  orgRole: "member",
  teamIds: [TEAM],
  teamRoles: { [TEAM]: "team_admin" },
});
const teamMember = actor({ orgRole: "member", teamIds: [TEAM], teamRoles: { [TEAM]: "member" } });
const projectAdmin = actor({
  orgRole: "member",
  projectGrants: [{ projectId: PROJECT, effectiveRole: "admin", accessSource: "user" }],
  projectIds: [PROJECT],
});
const projectReader = actor({
  orgRole: "member",
  projectGrants: [{ projectId: PROJECT, effectiveRole: "read", accessSource: "user" }],
  projectIds: [PROJECT],
});
const outsider = actor({ principalId: "user_out", organizationId: OTHER_ORG, orgRole: "org_admin" });
const platformAdmin = actor({ platformRole: "platform_admin", orgRole: "member" });

const WORKSPACE = { scopeKind: "workspace", scopeId: WORKSPACE_SCOPE_SENTINEL } as const;
const ORG_SCOPE = { scopeKind: "organization", scopeId: ORG } as const;
const TEAM_SCOPE = { scopeKind: "team", scopeId: TEAM } as const;
const PROJECT_SCOPE = { scopeKind: "project", scopeId: PROJECT } as const;
const SELF_SCOPE = { scopeKind: "user", scopeId: SELF } as const;

describe("assignment write authority — organization scope", () => {
  it("admits the organization's own admin", () => {
    expect(resolveAssignmentWriteAuthority(orgAdmin, ORG_SCOPE)).toEqual({
      allowed: true,
      via: "organization_admin",
    });
  });

  it("admits the organization's owner", () => {
    expect(resolveAssignmentWriteAuthority(orgOwner, ORG_SCOPE)).toEqual({
      allowed: true,
      via: "organization_owner",
    });
  });

  it("refuses a plain member of the same organization", () => {
    expect(resolveAssignmentWriteAuthority(orgMember, ORG_SCOPE)).toEqual({
      allowed: false,
      reason: "not-an-organization-admin",
    });
  });

  it("refuses an admin of a DIFFERENT organization (the exact-scope rule)", () => {
    expect(resolveAssignmentWriteAuthority(outsider, ORG_SCOPE)).toEqual({
      allowed: false,
      reason: "scope-outside-actor-organization",
    });
  });
});

describe("assignment write authority — team scope", () => {
  it("admits a team admin of THAT team", () => {
    expect(resolveAssignmentWriteAuthority(teamAdmin, TEAM_SCOPE)).toEqual({
      allowed: true,
      via: "team_admin",
    });
  });

  it("refuses a plain team member", () => {
    expect(resolveAssignmentWriteAuthority(teamMember, TEAM_SCOPE)).toEqual({
      allowed: false,
      reason: "not-a-team-admin",
    });
  });

  it("refuses a team admin of a different team", () => {
    expect(
      resolveAssignmentWriteAuthority(teamAdmin, { scopeKind: "team", scopeId: "team_other" }),
    ).toEqual({ allowed: false, reason: "not-a-team-admin" });
  });

  it("does NOT let an organization admin reach a team row by org width", () => {
    expect(resolveAssignmentWriteAuthority(orgAdmin, TEAM_SCOPE)).toEqual({
      allowed: false,
      reason: "not-a-team-admin",
    });
  });
});

describe("assignment write authority — project scope", () => {
  it("admits project admin", () => {
    expect(resolveAssignmentWriteAuthority(projectAdmin, PROJECT_SCOPE)).toEqual({
      allowed: true,
      via: "project_admin",
    });
  });

  it("refuses project read access", () => {
    expect(resolveAssignmentWriteAuthority(projectReader, PROJECT_SCOPE)).toEqual({
      allowed: false,
      reason: "not-a-project-admin",
    });
  });

  it("refuses an actor with no grant on that project", () => {
    expect(resolveAssignmentWriteAuthority(orgAdmin, PROJECT_SCOPE)).toEqual({
      allowed: false,
      reason: "not-a-project-admin",
    });
  });
});

describe("assignment write authority — user scope is an IDENTITY rule", () => {
  it("admits the person themselves", () => {
    expect(resolveAssignmentWriteAuthority(orgMember, SELF_SCOPE)).toEqual({
      allowed: true,
      via: "personal_self",
    });
  });

  it("refuses everyone else, an organization admin included", () => {
    expect(
      resolveAssignmentWriteAuthority(orgAdmin, { scopeKind: "user", scopeId: "user_other" }),
    ).toEqual({ allowed: false, reason: "not-self" });
  });

  it("refuses a platform admin reaching a person's own rows", () => {
    expect(
      resolveAssignmentWriteAuthority(platformAdmin, { scopeKind: "user", scopeId: "user_other" }),
    ).toEqual({ allowed: false, reason: "not-self" });
  });
});

describe("assignment write authority — workspace scope has NO grant road", () => {
  it.each([
    ["an organization owner", orgOwner],
    ["an organization admin", orgAdmin],
    ["a team admin", teamAdmin],
    ["a platform admin", platformAdmin],
  ])("refuses %s — the audited bypass is the only road", (_name, who) => {
    expect(resolveAssignmentWriteAuthority(who, WORKSPACE)).toEqual({
      allowed: false,
      reason: "workspace-requires-audited-bypass",
    });
  });
});

describe("assignment write authority — a malformed tuple fails closed", () => {
  it.each([
    ["a workspace row without the sentinel", { scopeKind: "workspace", scopeId: "org_1" }],
    ["a project row with no id", { scopeKind: "project", scopeId: "" }],
    ["a smuggled sentinel", { scopeKind: "team", scopeId: WORKSPACE_SCOPE_SENTINEL }],
    ["an unknown kind", { scopeKind: "everyone", scopeId: "x" }],
  ])("%s", (_name, scope) => {
    expect(resolveAssignmentWriteAuthority(orgOwner, scope as never)).toEqual({
      allowed: false,
      reason: "invalid-scope",
    });
  });
});

describe("assignment READ authority never requires write authority", () => {
  it("a plain organization member reads their organization's rows", () => {
    expect(resolveAssignmentReadAuthority(orgMember, ORG_SCOPE)).toEqual({ allowed: true });
  });

  it("a plain team member reads their team's rows", () => {
    expect(resolveAssignmentReadAuthority(teamMember, TEAM_SCOPE)).toEqual({ allowed: true });
  });

  it("project READ access is enough to read a project's rows", () => {
    expect(resolveAssignmentReadAuthority(projectReader, PROJECT_SCOPE)).toEqual({ allowed: true });
  });

  it("anyone in the instance reads the workspace rows", () => {
    expect(resolveAssignmentReadAuthority(orgMember, WORKSPACE)).toEqual({ allowed: true });
  });

  it("still fences another organization out", () => {
    expect(resolveAssignmentReadAuthority(outsider, ORG_SCOPE)).toEqual({
      allowed: false,
      reason: "scope-outside-actor-organization",
    });
  });

  it("still fences another person's own rows out", () => {
    expect(
      resolveAssignmentReadAuthority(orgAdmin, { scopeKind: "user", scopeId: "user_other" }),
    ).toEqual({ allowed: false, reason: "not-self" });
  });
});

// ── what the platform role does and does not contribute ───────────────────
describe("assignment write authority — the platform role contributes nothing", () => {
  const platformAdminWhoIsAlsoOrgAdmin = actor({
    platformRole: "platform_admin",
    orgRole: "org_admin",
  });
  const platformAdminOnly = actor({ platformRole: "platform_admin", orgRole: "member" });

  it("refuses a platform admin who holds no role in the organization", () => {
    expect(resolveAssignmentWriteAuthority(platformAdminOnly, ORG_SCOPE)).toEqual({
      allowed: false,
      reason: "not-an-organization-admin",
    });
  });

  it("admits a platform admin who is INDEPENDENTLY that organization's admin — as the org admin", () => {
    // The distinction the audited bypass depends on: this write is authorized
    // by the org_admin role, and it is recorded as such. Nothing was widened
    // by the platform role, and the same person is still refused everywhere
    // their org role does not reach.
    expect(resolveAssignmentWriteAuthority(platformAdminWhoIsAlsoOrgAdmin, ORG_SCOPE)).toEqual({
      allowed: true,
      via: "organization_admin",
    });
    expect(resolveAssignmentWriteAuthority(platformAdminWhoIsAlsoOrgAdmin, WORKSPACE)).toEqual({
      allowed: false,
      reason: "workspace-requires-audited-bypass",
    });
    expect(resolveAssignmentWriteAuthority(platformAdminWhoIsAlsoOrgAdmin, TEAM_SCOPE)).toEqual({
      allowed: false,
      reason: "not-a-team-admin",
    });
    expect(
      resolveAssignmentWriteAuthority(platformAdminWhoIsAlsoOrgAdmin, {
        scopeKind: "user",
        scopeId: "user_other",
      }),
    ).toEqual({ allowed: false, reason: "not-self" });
  });

  it("refuses a platform admin of ANOTHER organization at that organization's scope", () => {
    const foreign = actor({
      platformRole: "platform_admin",
      organizationId: OTHER_ORG,
      orgRole: "org_admin",
    });
    expect(resolveAssignmentWriteAuthority(foreign, ORG_SCOPE)).toEqual({
      allowed: false,
      reason: "scope-outside-actor-organization",
    });
  });
});

// ── the admission half, pinned where it stands today ──────────────────────
//
// Holding the permission is ADMISSION ("may administer assignments somewhere")
// and this resolver is the FENCE ("exactly here"). The two are not the same
// width today: the fence also authorizes a project owner/admin and a person's
// own user scope, and neither of those roads is a ROLE — project authority
// lives in `projectGrants`, not in the role table — so a plain member who
// administers a project holds no admission. That is a real boundary and it is
// pinned here rather than left to be discovered: the slice that builds the
// assignment SURFACE decides how admission is expressed for the project and
// personal roads, and this test fails the moment the grant table moves under
// it.
describe("assignment permissions — the admission set as it stands", () => {
  const ADMISSION = ["agent.assignments.manage", "context.assign"] as const;

  it("is held by org_admin (and org_owner by inheritance) and team_admin", () => {
    for (const perm of ADMISSION) {
      expect(roleHasPermission("org_admin", perm)).toBe(true);
      expect(roleHasPermission("org_owner", perm)).toBe(true);
      expect(roleHasPermission("team_admin", perm)).toBe(true);
    }
  });

  it("is held by neither a plain member nor platform_admin", () => {
    for (const perm of ADMISSION) {
      expect(roleHasPermission("member", perm)).toBe(false);
      expect(roleHasPermission("platform_admin", perm)).toBe(false);
    }
  });

  it("the fence is nonetheless WIDER than the admission for two roads", () => {
    // Documented, deliberate, and the surface slice's to resolve.
    expect(resolveAssignmentWriteAuthority(projectAdmin, PROJECT_SCOPE)).toEqual({
      allowed: true,
      via: "project_admin",
    });
    expect(resolveAssignmentWriteAuthority(orgMember, SELF_SCOPE)).toEqual({
      allowed: true,
      via: "personal_self",
    });
    for (const perm of ADMISSION) expect(roleHasPermission("member", perm)).toBe(false);
  });
});
