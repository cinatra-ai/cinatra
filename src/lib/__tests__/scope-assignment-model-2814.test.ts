/**
 * THE PER-SCOPE ASSIGNMENT PAGE'S PURE MODEL (cinatra#2814, per-scope
 * assignment S2).
 *
 * Three things are pinned here, each in the issue's own words:
 *
 *   - "`?tab=artifacts` on an assistant NORMALIZES to Skills", and Skills is
 *     the default everywhere;
 *   - "On organization/team/project/personal pages the route IMPLIES the
 *     scope": the route scope maps to exactly one assignment scope tuple;
 *   - "UI controls consume S1 resolver decisions without reproducing the
 *     policy matrix": every grant-road answer below is the S1 resolver's own
 *     answer, compared value for value, and the only thing the model adds is
 *     the audited platform-admin road S1 names.
 */
import { describe, expect, it } from "vitest";

import type { ActorContext, ProjectGrant } from "@/lib/authz/actor-context";
import { resolveAssignmentWriteAuthority } from "@/lib/authz/assignment-authority";
import { WORKSPACE_SCOPE_SENTINEL, type AssignmentScope } from "@/lib/assignment-scope";
import { buildWorkspaceVantage } from "@/lib/scope-surface-vantage";
import {
  SCOPE_ASSIGNMENT_ROOT_TEST_ID,
  assignmentScopeForSurfaceScope,
  buildWorkspaceEditorScopes,
  contextSlotBoundHint,
  contextSlotTakesText,
  contextSlotTitle,
  decideScopeAssignmentWrite,
  normalizeScopeAssignmentTab,
  scopeAssignmentRefusalText,
} from "@/lib/scope-assignment/scope-assignment-model";

const ORG = "org_acme";
const OTHER_ORG = "org_other";
const TEAM = "team_growth";
const PROJECT = "proj_launch";
const SEALED = "proj_sealed";
const ME = "user_me";
const SOMEONE = "user_someone";

function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: ME,
    authSource: "ui",
    policyVersion: "v2",
    organizationId: ORG,
    platformRole: "member",
    orgRole: "member",
    teamIds: [],
    teamRoles: {},
    projectGrants: [],
    ...overrides,
  } as ActorContext;
}

function grant(projectId: string, effectiveRole: ProjectGrant["effectiveRole"]): ProjectGrant {
  return { projectId, effectiveRole, accessSource: "user" };
}

const WS: AssignmentScope = { scopeKind: "workspace", scopeId: WORKSPACE_SCOPE_SENTINEL };

describe("the tab (issue #2814 change item 1)", () => {
  it("opens an agent on Skills by default", () => {
    expect(normalizeScopeAssignmentTab("agent", undefined)).toBe("skills");
    expect(normalizeScopeAssignmentTab("agent", "")).toBe("skills");
    expect(normalizeScopeAssignmentTab("agent", "skills")).toBe("skills");
  });

  it("opens an agent on Artifacts only when the address asks for it", () => {
    expect(normalizeScopeAssignmentTab("agent", "artifacts")).toBe("artifacts");
    expect(normalizeScopeAssignmentTab("agent", ["artifacts", "skills"])).toBe("artifacts");
  });

  it("reads an unknown tab as Skills", () => {
    expect(normalizeScopeAssignmentTab("agent", "context")).toBe("skills");
    expect(normalizeScopeAssignmentTab("agent", "ARTIFACTS")).toBe("skills");
  });

  it("normalizes ?tab=artifacts on an assistant to Skills", () => {
    expect(normalizeScopeAssignmentTab("assistant", "artifacts")).toBe("skills");
    expect(normalizeScopeAssignmentTab("assistant", ["artifacts"])).toBe("skills");
    expect(normalizeScopeAssignmentTab("assistant", undefined)).toBe("skills");
  });
});

describe("the route implies the scope (issue #2814 change item 1)", () => {
  it("maps every scope base to exactly one assignment tuple", () => {
    expect(assignmentScopeForSurfaceScope({ kind: "workspace" }, ME)).toEqual(WS);
    expect(assignmentScopeForSurfaceScope({ kind: "personal" }, ME)).toEqual({
      scopeKind: "user",
      scopeId: ME,
    });
    expect(assignmentScopeForSurfaceScope({ kind: "organization", id: ORG }, ME)).toEqual({
      scopeKind: "organization",
      scopeId: ORG,
    });
    expect(assignmentScopeForSurfaceScope({ kind: "team", id: TEAM }, ME)).toEqual({
      scopeKind: "team",
      scopeId: TEAM,
    });
    expect(assignmentScopeForSurfaceScope({ kind: "project", id: PROJECT }, ME)).toEqual({
      scopeKind: "project",
      scopeId: PROJECT,
    });
  });

  it("gives the personal scope to the signed-in person and nobody else", () => {
    expect(assignmentScopeForSurfaceScope({ kind: "personal" }, "")).toBeNull();
    expect(assignmentScopeForSurfaceScope({ kind: "personal" }, SOMEONE)).toEqual({
      scopeKind: "user",
      scopeId: SOMEONE,
    });
  });

  it("refuses an id-bearing scope without an id, and the storage sentinel as an id", () => {
    expect(assignmentScopeForSurfaceScope({ kind: "team", id: "" }, ME)).toBeNull();
    expect(
      assignmentScopeForSurfaceScope({ kind: "organization", id: WORKSPACE_SCOPE_SENTINEL }, ME),
    ).toBeNull();
  });
});

describe("write controls consume the S1 decision (issue #2814 change item 3)", () => {
  const cases: { name: string; actor: ActorContext; scope: AssignmentScope }[] = [
    { name: "personal self", actor: actor(), scope: { scopeKind: "user", scopeId: ME } },
    { name: "personal other", actor: actor(), scope: { scopeKind: "user", scopeId: SOMEONE } },
    {
      name: "project admin",
      actor: actor({ projectGrants: [grant(PROJECT, "admin")] }),
      scope: { scopeKind: "project", scopeId: PROJECT },
    },
    {
      name: "project owner",
      actor: actor({ projectGrants: [grant(PROJECT, "owner")] }),
      scope: { scopeKind: "project", scopeId: PROJECT },
    },
    {
      name: "project user (write)",
      actor: actor({ projectGrants: [grant(PROJECT, "write")] }),
      scope: { scopeKind: "project", scopeId: PROJECT },
    },
    {
      name: "project reader",
      actor: actor({ projectGrants: [grant(PROJECT, "read")] }),
      scope: { scopeKind: "project", scopeId: PROJECT },
    },
    {
      name: "team admin",
      actor: actor({ teamIds: [TEAM], teamRoles: { [TEAM]: "team_admin" } }),
      scope: { scopeKind: "team", scopeId: TEAM },
    },
    {
      name: "team member",
      actor: actor({ teamIds: [TEAM], teamRoles: { [TEAM]: "member" } }),
      scope: { scopeKind: "team", scopeId: TEAM },
    },
    {
      name: "org admin",
      actor: actor({ orgRole: "org_admin" }),
      scope: { scopeKind: "organization", scopeId: ORG },
    },
    {
      name: "org owner",
      actor: actor({ orgRole: "org_owner" }),
      scope: { scopeKind: "organization", scopeId: ORG },
    },
    {
      name: "org member",
      actor: actor(),
      scope: { scopeKind: "organization", scopeId: ORG },
    },
    {
      name: "org admin of another organization",
      actor: actor({ orgRole: "org_admin" }),
      scope: { scopeKind: "organization", scopeId: OTHER_ORG },
    },
    {
      name: "org admin at a sealed-room project they hold no grant on",
      actor: actor({ orgRole: "org_admin", projectGrants: [grant(PROJECT, "admin")] }),
      scope: { scopeKind: "project", scopeId: SEALED },
    },
    { name: "workspace, member", actor: actor({ orgRole: "org_owner" }), scope: WS },
  ];

  for (const c of cases) {
    it(`agrees with the S1 resolver value for value: ${c.name}`, () => {
      const s1 = resolveAssignmentWriteAuthority(c.actor, c.scope);
      const decision = decideScopeAssignmentWrite(c.actor, c.scope);
      if (s1.allowed) {
        expect(decision).toEqual({ allowed: true, road: "grant", via: s1.via });
      } else {
        expect(decision).toEqual({ allowed: false, reason: s1.reason });
      }
    });
  }

  it("reads the matrix the issue states, per scope", () => {
    const allowed = (a: ActorContext, s: AssignmentScope) => decideScopeAssignmentWrite(a, s).allowed;
    expect(allowed(actor(), { scopeKind: "user", scopeId: ME })).toBe(true);
    expect(allowed(actor(), { scopeKind: "user", scopeId: SOMEONE })).toBe(false);
    expect(
      allowed(actor({ projectGrants: [grant(PROJECT, "admin")] }), {
        scopeKind: "project",
        scopeId: PROJECT,
      }),
    ).toBe(true);
    expect(
      allowed(actor({ projectGrants: [grant(PROJECT, "write")] }), {
        scopeKind: "project",
        scopeId: PROJECT,
      }),
    ).toBe(false);
    expect(
      allowed(actor({ teamRoles: { [TEAM]: "team_admin" } }), { scopeKind: "team", scopeId: TEAM }),
    ).toBe(true);
    expect(
      allowed(actor({ teamRoles: { [TEAM]: "member" } }), { scopeKind: "team", scopeId: TEAM }),
    ).toBe(false);
    // The sealed room is unaffected: an organization admin gains no authority
    // over a project whose access they were never given.
    expect(
      allowed(actor({ orgRole: "org_admin" }), { scopeKind: "project", scopeId: SEALED }),
    ).toBe(false);
    expect(allowed(actor({ orgRole: "org_owner" }), WS)).toBe(false);
  });

  it("sends a platform admin at the workspace through the audited workspace bypass", () => {
    expect(decideScopeAssignmentWrite(actor({ platformRole: "platform_admin" }), WS)).toEqual({
      allowed: true,
      road: "audited-bypass",
      reason: "workspace_configuration",
    });
  });

  it("sends a platform admin with no scope role through the audited scope bypass", () => {
    const admin = actor({ platformRole: "platform_admin" });
    for (const scope of [
      { scopeKind: "organization", scopeId: ORG },
      { scopeKind: "team", scopeId: TEAM },
      { scopeKind: "project", scopeId: SEALED },
    ] as AssignmentScope[]) {
      expect(decideScopeAssignmentWrite(admin, scope)).toEqual({
        allowed: true,
        road: "audited-bypass",
        reason: "scope_configuration",
      });
    }
  });

  it("never gives a platform admin a direct grant: an org admin who is also one takes the org-admin road", () => {
    expect(
      decideScopeAssignmentWrite(actor({ platformRole: "platform_admin", orgRole: "org_admin" }), {
        scopeKind: "organization",
        scopeId: ORG,
      }),
    ).toEqual({ allowed: true, road: "grant", via: "organization_admin" });
  });

  it("offers a platform admin no road into another person's personal rows", () => {
    expect(
      decideScopeAssignmentWrite(actor({ platformRole: "platform_admin" }), {
        scopeKind: "user",
        scopeId: SOMEONE,
      }),
    ).toEqual({ allowed: false, reason: "not-self" });
  });

  it("refuses a malformed scope before any road is considered", () => {
    expect(
      decideScopeAssignmentWrite(actor({ platformRole: "platform_admin" }), {
        scopeKind: "workspace",
        scopeId: "org_acme",
      } as AssignmentScope),
    ).toEqual({ allowed: false, reason: "invalid-scope" });
  });

  it("explains every refusal in words, never as a machine token", () => {
    for (const reason of [
      "invalid-scope",
      "workspace-requires-audited-bypass",
      "scope-outside-actor-organization",
      "not-an-organization-admin",
      "not-a-team-admin",
      "not-a-project-admin",
      "not-self",
    ] as const) {
      const text = scopeAssignmentRefusalText(reason);
      expect(text).not.toMatch(/-/);
      expect(text.length).toBeGreaterThan(10);
    }
  });
});

describe("the workspace cross-scope editor's scopes (issue #2814 change item 2)", () => {
  it("lists the workspace tier, the actor's own scope, then every vantage organization with its teams and projects", () => {
    const vantage = buildWorkspaceVantage({
      userId: ME,
      memberships: [{ orgId: OTHER_ORG }, { orgId: ORG }],
      teamIdsByOrg: { [ORG]: [TEAM] },
      projectIdsByOrg: { [ORG]: [PROJECT], [OTHER_ORG]: ["proj_z"] },
    });
    expect(buildWorkspaceEditorScopes(vantage)).toEqual([
      { scope: { kind: "workspace" }, orgId: null },
      { scope: { kind: "personal" }, orgId: null },
      { scope: { kind: "organization", id: ORG }, orgId: ORG },
      { scope: { kind: "team", id: TEAM }, orgId: ORG },
      { scope: { kind: "project", id: PROJECT }, orgId: ORG },
      { scope: { kind: "organization", id: OTHER_ORG }, orgId: OTHER_ORG },
      { scope: { kind: "project", id: "proj_z" }, orgId: OTHER_ORG },
    ]);
  });

  it("carries only the workspace tier and the personal scope for an actor with no membership", () => {
    const vantage = buildWorkspaceVantage({ userId: ME, memberships: [] });
    expect(buildWorkspaceEditorScopes(vantage)).toEqual([
      { scope: { kind: "workspace" }, orgId: null },
      { scope: { kind: "personal" }, orgId: null },
    ]);
  });
});

describe("the context slot group's words (issue #2814 change item 4)", () => {
  it("names a slot from its id", () => {
    expect(contextSlotTitle("brand-voice")).toBe("Brand voice");
    expect(contextSlotTitle("referencePosts")).toBe("Reference posts");
    expect(contextSlotTitle("icp_profile")).toBe("Icp profile");
  });

  it("states what the slot takes and its bounds", () => {
    expect(contextSlotTakesText(["Brand Kit"], 1, 2)).toBe("Takes a brand kit · 1 required, at most 2");
    expect(contextSlotTakesText(["Blog Post"], 0, 3)).toBe("Takes a blog post · optional, at most 3");
    expect(contextSlotTakesText(["Icp"], 0, undefined)).toBe("Takes an icp · optional");
    expect(contextSlotTakesText(["Brand Kit", "Blog Post"], 2, undefined)).toBe(
      "Takes a brand kit or a blog post · 2 required",
    );
  });

  it("closes a slot off at its upper bound and says what to do about it", () => {
    expect(contextSlotBoundHint(2, 2)).toBe("2 of 2 artifacts chosen. Remove one to choose another.");
    expect(contextSlotBoundHint(1, 2)).toBeNull();
    expect(contextSlotBoundHint(7, undefined)).toBeNull();
  });
});

describe("the named assignment-content root", () => {
  it("is one stable test id", () => {
    expect(SCOPE_ASSIGNMENT_ROOT_TEST_ID).toBe("scope-assignment-page");
  });
});
