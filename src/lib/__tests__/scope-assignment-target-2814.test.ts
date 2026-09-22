/**
 * THE ASSIGNMENT TARGET IS RE-RESOLVED ON THE SERVER (cinatra#2814, per-scope
 * assignment S2).
 *
 *   - "every read/write re-resolves agent + scope server-side": the package
 *     comes from the rows the scope's own tab lists for this reader, so a
 *     forged pair resolves to nothing;
 *   - "On organization/team/project/personal pages the route IMPLIES the
 *     scope, no picker";
 *   - "the workspace page's per-agent page shows the agent's rows in every
 *     scope in the normative WorkspaceVantage; editability is then calculated
 *     independently by S1's exact-scope resolver (the actor's authority scopes
 *     + personal)", with fixtures per role.
 */
import { describe, expect, it, vi } from "vitest";

import type { ActorContext, ProjectGrant } from "@/lib/authz/actor-context";
import { WORKSPACE_SCOPE_SENTINEL } from "@/lib/assignment-scope";
import { buildWorkspaceVantage } from "@/lib/scope-surface-vantage";
import type { ScopeAgentCardRow, ScopeAssistantCardRow } from "@/lib/scope-surface-rows";
import type { ScopeSurfaceRef } from "@/lib/scope-surfaces";
import {
  resolveScopeAssignmentTarget,
  selectScopeAssignmentSection,
  type ScopeAssignmentTargetDeps,
} from "@/lib/scope-assignment/scope-assignment-target.server";

const ME = "user_me";
const ORG = "org_acme";
const ORG2 = "org_beta";
const TEAM = "team_growth";
const TEAM2 = "team_ops";
const PROJECT = "proj_launch";
const SEALED = "proj_sealed";

type Grants = {
  projectGrants: ProjectGrant[];
  teamIds: string[];
  teamRoles?: Record<string, "team_admin" | "member">;
  orgRole?: "org_owner" | "org_admin" | "member";
};

function agentRow(packageName: string): ScopeAgentCardRow {
  return {
    key: packageName,
    name: "Research Agent",
    description: "",
    host: "local",
    packageName,
    detailHref: null,
    runHref: "",
    settingsHref: "",
    version: null,
    status: "active",
  };
}

function assistantRow(packageName: string, vendor: string, slug: string): ScopeAssistantCardRow {
  return {
    key: packageName,
    packageName,
    vendor,
    slug,
    displayName: "Support Assistant",
    description: null,
    chatHref: "",
    settingsHref: "",
    remoteCapable: false,
    remoteInstances: [],
    version: null,
    status: "active",
  };
}

function deps(opts: {
  platformAdmin?: boolean;
  activeOrgId?: string | null;
  grantsByOrg?: Record<string, Grants>;
  agentRows?: (scope: ScopeSurfaceRef) => ScopeAgentCardRow[];
  assistantRows?: (scope: ScopeSurfaceRef) => ScopeAssistantCardRow[];
}): ScopeAssignmentTargetDeps & { readGrantsInOrg: ReturnType<typeof vi.fn> } {
  const base: ActorContext = {
    principalType: "HumanUser",
    principalId: ME,
    authSource: "ui",
    policyVersion: "v2",
    organizationId: opts.activeOrgId ?? ORG,
    platformRole: opts.platformAdmin ? "platform_admin" : "member",
    orgRole: "member",
    teamIds: [],
    projectGrants: [],
  } as ActorContext;
  const vantage = buildWorkspaceVantage({
    userId: ME,
    memberships: [{ orgId: ORG }, { orgId: ORG2 }],
    teamIdsByOrg: { [ORG]: [TEAM, TEAM2] },
    projectIdsByOrg: { [ORG]: [PROJECT, SEALED] },
  });
  return {
    readSession: async () => ({ userId: ME, activeOrgId: opts.activeOrgId ?? ORG }),
    readBaseActor: async () => base,
    readGrantsInOrg: vi.fn(async (_u: string, orgId: string) => ({
      projectGrants: [],
      teamIds: [],
      ...(opts.grantsByOrg?.[orgId] ?? {}),
    })),
    readMembership: async () => ({
      vantage,
      scopeNames: { [`organization:${ORG}`]: "Acme", [`team:${TEAM}`]: "Growth" },
    }),
    readAgentRows: async (scope) =>
      opts.agentRows ? opts.agentRows(scope) : [agentRow("@cinatra-ai/research-agent")],
    readAssistantRows: async (scope) =>
      opts.assistantRows
        ? opts.assistantRows(scope)
        : [assistantRow("@cinatra-ai/support-assistant", "cinatra-ai", "support")],
    assertWriteTarget: async () => ({ ok: true }),
  };
}

const AGENT = { surface: "agent" as const, vendor: "cinatra-ai", name: "research-agent" };

describe("the package is re-resolved from the scope tab's own rows", () => {
  it("resolves the agent pair to the canonical package on every scope base", async () => {
    for (const scope of [
      { kind: "workspace" },
      { kind: "personal" },
      { kind: "organization", id: ORG },
      { kind: "team", id: TEAM },
      { kind: "project", id: PROJECT },
    ] as ScopeSurfaceRef[]) {
      const target = await resolveScopeAssignmentTarget(
        { ...AGENT, scope },
        deps({ grantsByOrg: { [ORG]: { teamIds: [TEAM], projectGrants: [{ projectId: PROJECT, effectiveRole: "read", accessSource: "user" }] } } }),
      );
      expect(target?.packageName, scope.kind).toBe("@cinatra-ai/research-agent");
      expect(target?.routeScope).toEqual(scope);
    }
  });

  it("resolves the assistant codec pair to the package it denotes", async () => {
    const target = await resolveScopeAssignmentTarget(
      { surface: "assistant", scope: { kind: "personal" }, vendor: "cinatra-ai", name: "support" },
      deps({}),
    );
    expect(target?.packageName).toBe("@cinatra-ai/support-assistant");
    expect(target?.surface).toBe("assistant");
  });

  it("refuses a forged pair the tab does not list (server re-resolution)", async () => {
    for (const forged of [
      { vendor: "cinatra-ai", name: "not-installed" },
      { vendor: "evil", name: "research-agent" },
      { vendor: "cinatra-ai", name: "research-agent/../x" },
      { vendor: "@cinatra-ai", name: "research-agent" },
      { vendor: "", name: "research-agent" },
    ]) {
      expect(
        await resolveScopeAssignmentTarget({ surface: "agent", scope: { kind: "personal" }, ...forged }, deps({})),
      ).toBeNull();
    }
  });

  it("refuses an assistant addressed through the agents tree, and an agent through the assistants tree", async () => {
    expect(
      await resolveScopeAssignmentTarget(
        { surface: "agent", scope: { kind: "personal" }, vendor: "cinatra-ai", name: "support-assistant" },
        deps({}),
      ),
    ).toBeNull();
    expect(
      await resolveScopeAssignmentTarget(
        { surface: "assistant", scope: { kind: "personal" }, vendor: "cinatra-ai", name: "research-agent" },
        deps({}),
      ),
    ).toBeNull();
  });

  it("refuses a package another scope lists but this one does not", async () => {
    const d = deps({
      agentRows: (scope) => (scope.kind === "team" ? [] : [agentRow("@cinatra-ai/research-agent")]),
      grantsByOrg: { [ORG]: { teamIds: [TEAM], projectGrants: [] } },
    });
    expect(await resolveScopeAssignmentTarget({ ...AGENT, scope: { kind: "team", id: TEAM } }, d)).toBeNull();
    expect(await resolveScopeAssignmentTarget({ ...AGENT, scope: { kind: "organization", id: ORG } }, d)).not.toBeNull();
  });

  it("refuses without a session", async () => {
    const d = deps({});
    d.readSession = async () => null;
    expect(await resolveScopeAssignmentTarget({ ...AGENT, scope: { kind: "personal" } }, d)).toBeNull();
  });
});

describe("the route implies the scope", () => {
  it("gives the personal page the session's own user tuple", async () => {
    const target = await resolveScopeAssignmentTarget({ ...AGENT, scope: { kind: "personal" } }, deps({}));
    expect(target?.sections.map((s) => s.assignmentScope)).toEqual([{ scopeKind: "user", scopeId: ME }]);
    expect(target?.sections[0]!.write).toEqual({ allowed: true, road: "grant", via: "personal_self" });
  });

  it("reads an organization page's authority in THAT organization, not the session's", async () => {
    const d = deps({ activeOrgId: ORG2, grantsByOrg: { [ORG]: { orgRole: "org_admin", teamIds: [], projectGrants: [] } } });
    const target = await resolveScopeAssignmentTarget({ ...AGENT, scope: { kind: "organization", id: ORG } }, d);
    expect(d.readGrantsInOrg).toHaveBeenCalledWith(ME, ORG);
    expect(target?.sections[0]!.actor.organizationId).toBe(ORG);
    expect(target?.sections[0]!.write).toEqual({ allowed: true, road: "grant", via: "organization_admin" });
  });

  it("refuses a scope outside the reader's memberships", async () => {
    expect(
      await resolveScopeAssignmentTarget({ ...AGENT, scope: { kind: "organization", id: "org_elsewhere" } }, deps({})),
    ).toBeNull();
    expect(
      await resolveScopeAssignmentTarget({ ...AGENT, scope: { kind: "team", id: "team_elsewhere" } }, deps({})),
    ).toBeNull();
  });

  it("refuses a project page the reader holds no grant on (the sealed room stays sealed)", async () => {
    const d = deps({ grantsByOrg: { [ORG]: { orgRole: "org_admin", teamIds: [], projectGrants: [] } } });
    expect(await resolveScopeAssignmentTarget({ ...AGENT, scope: { kind: "project", id: SEALED } }, d)).toBeNull();
  });

  it("shows a team member the team's page read-only, and a team admin a writable one", async () => {
    const member = await resolveScopeAssignmentTarget(
      { ...AGENT, scope: { kind: "team", id: TEAM } },
      deps({ grantsByOrg: { [ORG]: { teamIds: [TEAM], teamRoles: { [TEAM]: "member" }, projectGrants: [] } } }),
    );
    expect(member?.sections[0]!.write).toEqual({ allowed: false, reason: "not-a-team-admin" });
    const admin = await resolveScopeAssignmentTarget(
      { ...AGENT, scope: { kind: "team", id: TEAM } },
      deps({ grantsByOrg: { [ORG]: { teamIds: [TEAM], teamRoles: { [TEAM]: "team_admin" }, projectGrants: [] } } }),
    );
    expect(admin?.sections[0]!.write).toEqual({ allowed: true, road: "grant", via: "team_admin" });
  });

  it("shows a project user the project's page read-only, and a project admin a writable one", async () => {
    const user = await resolveScopeAssignmentTarget(
      { ...AGENT, scope: { kind: "project", id: PROJECT } },
      deps({ grantsByOrg: { [ORG]: { teamIds: [], projectGrants: [{ projectId: PROJECT, effectiveRole: "write", accessSource: "user" }] } } }),
    );
    expect(user?.sections[0]!.write).toEqual({ allowed: false, reason: "not-a-project-admin" });
    const admin = await resolveScopeAssignmentTarget(
      { ...AGENT, scope: { kind: "project", id: PROJECT } },
      deps({ grantsByOrg: { [ORG]: { teamIds: [], projectGrants: [{ projectId: PROJECT, effectiveRole: "admin", accessSource: "user" }] } } }),
    );
    expect(admin?.sections[0]!.write).toEqual({ allowed: true, road: "grant", via: "project_admin" });
  });
});

describe("the workspace cross-scope editor edits exactly the actor's authority scopes (fixtures per role)", () => {
  const WS = { kind: "workspace" } as const;
  const editable = async (d: ScopeAssignmentTargetDeps) => {
    const target = await resolveScopeAssignmentTarget({ ...AGENT, scope: WS }, d);
    return Object.fromEntries(
      (target?.sections ?? []).map((s) => [
        "id" in s.scope ? `${s.scope.kind}:${s.scope.id}` : s.scope.kind,
        s.write.allowed ? (s.write.road === "grant" ? s.write.via : `bypass:${s.write.reason}`) : false,
      ]),
    );
  };

  it("a plain member edits their own personal row and nothing else", async () => {
    expect(
      await editable(
        deps({
          grantsByOrg: {
            [ORG]: { teamIds: [TEAM], teamRoles: { [TEAM]: "member" }, projectGrants: [{ projectId: PROJECT, effectiveRole: "read", accessSource: "user" }] },
          },
        }),
      ),
    ).toEqual({
      workspace: false,
      personal: "personal_self",
      [`organization:${ORG}`]: false,
      [`team:${TEAM}`]: false,
      [`project:${PROJECT}`]: false,
      [`organization:${ORG2}`]: false,
    });
  });

  it("an org admin edits their organization's row, not its teams, not a sealed project, not another organization", async () => {
    expect(
      await editable(
        deps({
          grantsByOrg: {
            [ORG]: { orgRole: "org_admin", teamIds: [TEAM], teamRoles: { [TEAM]: "member" }, projectGrants: [{ projectId: PROJECT, effectiveRole: "read", accessSource: "organization" }] },
          },
        }),
      ),
    ).toEqual({
      workspace: false,
      personal: "personal_self",
      [`organization:${ORG}`]: "organization_admin",
      [`team:${TEAM}`]: false,
      [`project:${PROJECT}`]: false,
      [`organization:${ORG2}`]: false,
    });
  });

  it("a team admin edits exactly the team they administer", async () => {
    expect(
      await editable(
        deps({
          grantsByOrg: {
            [ORG]: { teamIds: [TEAM, TEAM2], teamRoles: { [TEAM]: "team_admin", [TEAM2]: "member" }, projectGrants: [] },
          },
        }),
      ),
    ).toMatchObject({ [`team:${TEAM}`]: "team_admin", [`team:${TEAM2}`]: false, [`organization:${ORG}`]: false });
  });

  it("a project owner edits exactly the project they own", async () => {
    expect(
      await editable(
        deps({
          grantsByOrg: {
            [ORG]: { teamIds: [], projectGrants: [{ projectId: PROJECT, effectiveRole: "owner", accessSource: "owner" }] },
          },
        }),
      ),
    ).toMatchObject({ [`project:${PROJECT}`]: "project_owner", [`organization:${ORG}`]: false });
  });

  it("a platform admin edits the true workspace rows and org/team/project rows only through the audited bypass", async () => {
    const result = await editable(
      deps({
        platformAdmin: true,
        grantsByOrg: {
          [ORG]: { teamIds: [TEAM], teamRoles: { [TEAM]: "member" }, projectGrants: [{ projectId: PROJECT, effectiveRole: "read", accessSource: "user" }] },
        },
      }),
    );
    expect(result).toEqual({
      workspace: "bypass:workspace_configuration",
      personal: "personal_self",
      [`organization:${ORG}`]: "bypass:scope_configuration",
      [`team:${TEAM}`]: "bypass:scope_configuration",
      [`project:${PROJECT}`]: "bypass:scope_configuration",
      [`organization:${ORG2}`]: "bypass:scope_configuration",
    });
  });

  it("shows a scope once, even when the membership reader lists a project under two organizations", async () => {
    const d = deps({
      grantsByOrg: {
        [ORG]: { teamIds: [], projectGrants: [{ projectId: PROJECT, effectiveRole: "admin", accessSource: "user" }] },
        [ORG2]: { teamIds: [], projectGrants: [{ projectId: PROJECT, effectiveRole: "admin", accessSource: "user" }] },
      },
    });
    d.readMembership = async () => ({
      vantage: buildWorkspaceVantage({
        userId: ME,
        memberships: [{ orgId: ORG }, { orgId: ORG2 }],
        projectIdsByOrg: { [ORG]: [PROJECT], [ORG2]: [PROJECT] },
      }),
      scopeNames: {},
    });
    const target = await resolveScopeAssignmentTarget({ ...AGENT, scope: WS }, d);
    expect(target?.sections.filter((s) => s.scope.kind === "project")).toHaveLength(1);
  });

  it("carries the true workspace tuple on the sentinel", async () => {
    const target = await resolveScopeAssignmentTarget({ ...AGENT, scope: WS }, deps({}));
    expect(target?.sections[0]!.assignmentScope).toEqual({ scopeKind: "workspace", scopeId: WORKSPACE_SCOPE_SENTINEL });
  });
});

describe("a write names one of the page's own scopes", () => {
  it("accepts the page's scope on a single-scope page and refuses any other", async () => {
    const target = (await resolveScopeAssignmentTarget(
      { ...AGENT, scope: { kind: "team", id: TEAM } },
      deps({ grantsByOrg: { [ORG]: { teamIds: [TEAM], teamRoles: { [TEAM]: "team_admin" }, projectGrants: [] } } }),
    ))!;
    expect(selectScopeAssignmentSection(target, undefined)?.scope).toEqual({ kind: "team", id: TEAM });
    expect(selectScopeAssignmentSection(target, { kind: "team", id: TEAM })?.scope).toEqual({ kind: "team", id: TEAM });
    expect(selectScopeAssignmentSection(target, { kind: "team", id: TEAM2 })).toBeNull();
    expect(selectScopeAssignmentSection(target, { kind: "workspace" })).toBeNull();
  });

  it("on the workspace page requires a section the page shows", async () => {
    const target = (await resolveScopeAssignmentTarget({ ...AGENT, scope: { kind: "workspace" } }, deps({})))!;
    expect(selectScopeAssignmentSection(target, { kind: "organization", id: ORG })?.scope).toEqual({
      kind: "organization",
      id: ORG,
    });
    expect(selectScopeAssignmentSection(target, { kind: "organization", id: "org_elsewhere" })).toBeNull();
    expect(selectScopeAssignmentSection(target, undefined)).toBeNull();
    expect(selectScopeAssignmentSection(target, { kind: "personal" })?.assignmentScope).toEqual({
      scopeKind: "user",
      scopeId: ME,
    });
  });
});
