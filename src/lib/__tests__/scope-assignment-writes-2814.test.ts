/**
 * THE PER-SCOPE ASSIGNMENT WRITES (cinatra#2814, per-scope assignment S2).
 *
 *   - "forged mutations still reach and are refused by the S1 resolver": a
 *     write that never rendered the page (or rendered it for someone else)
 *     gets S1's own typed refusal, and no store is called;
 *   - the matrix: personal = self; project = project admin/owner; team = team
 *     admins; organization = org admins; workspace = platform admins only,
 *     through the audited bypass, never a direct grant; the audit row is
 *     written BEFORE the store mutation and an audit failure aborts it;
 *   - "add/remove/reorder issue the correct tuple calls and SURFACE the typed
 *     refusals";
 *   - assistants take skills only.
 */
import { describe, expect, it, vi } from "vitest";

import type { ActorContext, ProjectGrant } from "@/lib/authz/actor-context";
import { WORKSPACE_SCOPE_SENTINEL } from "@/lib/assignment-scope";
import { buildWorkspaceVantage } from "@/lib/scope-surface-vantage";
import type { AgentContextSlot } from "@cinatra-ai/extensions/agent-context-slots-reader";
import type { SkillAssignability } from "@cinatra-ai/skills/agent-skill-assignability";
import type { ScopeAssignmentActionTarget } from "@/lib/scope-assignment/scope-assignment-model";
import type { ScopeAssignmentReadDeps } from "@/lib/scope-assignment/scope-assignment-reads.server";
import {
  SCOPE_ASSIGNMENT_AUDIT_OPERATION,
  assignScopeContextArtifact,
  assignScopeSkill,
  removeScopeContextArtifact,
  removeScopeSkill,
  reorderScopeContextArtifacts,
  searchScopeContextArtifacts,
  searchScopeSkills,
  type ScopeAssignmentWriteDeps,
} from "@/lib/scope-assignment/scope-assignment-writes.server";

const ME = "user_me";
const OTHER = "user_other";
const ORG = "org_acme";
const TEAM = "team_growth";
const PROJECT = "proj_launch";
const PKG = "@cinatra-ai/scope-fixture-agent";
const SKILL = "@cinatra-ai/blog-skills:blog-writing";
const SLOT: AgentContextSlot = {
  slotId: "brand-voice",
  acceptedArtifactExtensions: ["@cinatra-ai/brand-kit-artifact"],
  selectionMode: "interactive",
  resolutionMode: "accumulate",
  minItems: 1,
  maxItems: 2,
};

type Grants = {
  projectGrants: ProjectGrant[];
  teamIds: string[];
  teamRoles?: Record<string, "team_admin" | "member">;
  orgRole?: "org_owner" | "org_admin" | "member";
};

function assignable(skillId: string, ok = true): SkillAssignability {
  return {
    skillId,
    assignable: ok,
    reason: ok ? null : "archived",
    ownerPackageName: "@cinatra-ai/blog-skills",
    role: "injectable",
    skill: { id: skillId, name: "Blog Writing", description: "", level: null },
  };
}

function harness(opts: {
  userId?: string;
  platformAdmin?: boolean;
  grants?: Grants;
  admission?: { ok: true } | { ok: false; reason: "not-an-agent" | "eligibility-unreadable" };
  auditFails?: boolean;
  artifact?: { visible: boolean; extensions: string[] };
  slots?: AgentContextSlot[] | "unreadable";
}) {
  const userId = opts.userId ?? ME;
  const events: string[] = [];
  const base = {
    principalType: "HumanUser",
    principalId: userId,
    authSource: "ui",
    policyVersion: "v2",
    organizationId: ORG,
    platformRole: opts.platformAdmin ? "platform_admin" : "member",
    orgRole: "member",
    teamIds: [],
    projectGrants: [],
  } as ActorContext;
  const reads: ScopeAssignmentReadDeps = {
    readAssignedSkills: vi.fn(async () => []),
    resolveAssignability: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, assignable(id)]))),
    listSkillCandidates: vi.fn(async () => [
      {
        skillId: SKILL,
        skillName: "Blog Writing",
        skillDescription: "",
        ownerPackageName: "@cinatra-ai/blog-skills",
        ownerPackageCandidates: ["@cinatra-ai/blog-skills"],
        extensionDisplayName: "Blog Skills",
        extensionVendorName: "Cinatra",
        extensionAuthor: null,
        role: "injectable" as const,
      },
    ]),
    readInstallStatuses: vi.fn(async () => new Map()),
    readAssignedContext: vi.fn(async () => []),
    readArtifact: vi.fn(async ({ artifactId }: { artifactId: string }) =>
      opts.artifact?.visible === false
        ? ({ kind: "denied" } as const)
        : ({
            kind: "ok",
            artifact: {
              artifactId,
              title: "Brand Kit 2026",
              eligibleExtensions: opts.artifact?.extensions ?? ["@cinatra-ai/brand-kit-artifact"],
              primaryExtension: null,
              projectId: null,
            },
          } as const),
    ),
    listArtifacts: vi.fn(async () => [
      { artifactId: "res_kit", title: "Brand Kit 2026", eligibleExtensions: ["@cinatra-ai/brand-kit-artifact"], primaryExtension: null, projectId: null },
      { artifactId: "res_post", title: "Launch Post", eligibleExtensions: ["@cinatra-ai/blog-post-artifact"], primaryExtension: null, projectId: null },
    ]),
    expandAcceptedExtensions: vi.fn(async (accepted: readonly string[]) => [...accepted]),
    artifactKindLabel: (ext: string) => (ext.includes("brand") ? "Brand Kit" : "Blog Post"),
    resolveVendorName: (input) => input.manifestVendorName ?? input.author,
  };
  const deps: ScopeAssignmentWriteDeps = {
    target: {
      readSession: async () => ({ userId, activeOrgId: ORG }),
      readBaseActor: async () => base,
      readGrantsInOrg: async () => opts.grants ?? { projectGrants: [], teamIds: [] },
      readMembership: async () => ({
        vantage: buildWorkspaceVantage({
          userId,
          memberships: [{ orgId: ORG }],
          teamIdsByOrg: { [ORG]: [TEAM] },
          projectIdsByOrg: { [ORG]: [PROJECT] },
        }),
        scopeNames: {},
      }),
      readAgentRows: async () => [
        { key: PKG, name: "Research Agent", description: "", host: "local", packageName: PKG, detailHref: null, runHref: "", settingsHref: "", version: null, status: "active" },
      ],
      readAssistantRows: async () => [
        { key: "@cinatra-ai/support-assistant", packageName: "@cinatra-ai/support-assistant", vendor: "cinatra-ai", slug: "support", displayName: "Support", description: null, chatHref: "", settingsHref: "", remoteCapable: false, remoteInstances: [], version: null, status: "active" },
      ],
      assertWriteTarget: async () => opts.admission ?? { ok: true },
    },
    reads,
    bypass: vi.fn(async (...args: unknown[]) => {
      events.push(`audit:${String(args[3])}`);
      if (opts.auditFails) throw new Error("audit store down");
      return { auditEventId: "aud_1" };
    }),
    resolveAssignability: reads.resolveAssignability,
    withInstallLock: vi.fn(async (_pkg: string, fn: () => Promise<unknown>) => fn()) as never,
    insertSkill: vi.fn(async (input) => {
      events.push("store:insertSkill");
      return { outcome: "assigned", row: { ...input, source: "manual", originRunId: null, position: 1, createdAt: "", scopeKind: input.scope.scopeKind, scopeId: input.scope.scopeId } } as never;
    }),
    deleteSkill: vi.fn(async () => {
      events.push("store:deleteSkill");
      return { deleted: true };
    }),
    readSlots: vi.fn(async () =>
      opts.slots === "unreadable" ? ({ ok: false, reason: "manifest-unreadable" } as const) : { ok: true as const, slots: opts.slots ?? [SLOT] },
    ),
    insertContext: vi.fn(async (input, validators) => {
      events.push("store:insertContext");
      // The real store's order, so the validators wired by the action are
      // exercised exactly as the store runs them.
      if (!(await validators.slotExists(input))) return { outcome: "refused", reason: "unknown-slot" } as const;
      if (!(await validators.artifactVisibleToWriter({ artifactId: input.artifactId, writerId: input.createdBy, scope: input.scope }))) {
        return { outcome: "refused", reason: "artifact-not-visible" } as const;
      }
      if (!(await validators.slotAcceptsArtifact(input))) return { outcome: "refused", reason: "incompatible-artifact" } as const;
      return { outcome: "assigned", row: {} } as never;
    }),
    deleteContext: vi.fn(async () => {
      events.push("store:deleteContext");
      return { deleted: true };
    }),
    reorderContext: vi.fn(async () => {
      events.push("store:reorderContext");
      return { outcome: "reordered" } as const;
    }),
  };
  return { deps, events };
}

const agentAt = (scope: ScopeAssignmentActionTarget["scope"], section?: ScopeAssignmentActionTarget["section"]): ScopeAssignmentActionTarget => ({
  surface: "agent",
  scope,
  vendor: "cinatra-ai",
  name: "scope-fixture-agent",
  ...(section ? { section } : {}),
});

const noStoreCalls = (deps: ScopeAssignmentWriteDeps) => {
  expect(deps.insertSkill).not.toHaveBeenCalled();
  expect(deps.deleteSkill).not.toHaveBeenCalled();
  expect(deps.insertContext).not.toHaveBeenCalled();
  expect(deps.deleteContext).not.toHaveBeenCalled();
  expect(deps.reorderContext).not.toHaveBeenCalled();
};

describe("forged mutations reach the S1 resolver and are refused by it", () => {
  it("a team member's forged skill write gets S1's refusal and touches no store", async () => {
    const { deps } = harness({ grants: { teamIds: [TEAM], teamRoles: { [TEAM]: "member" }, projectGrants: [] } });
    expect(await assignScopeSkill(agentAt({ kind: "team", id: TEAM }), SKILL, deps)).toEqual({
      ok: false,
      reason: "not-a-team-admin",
    });
    expect(await removeScopeSkill(agentAt({ kind: "team", id: TEAM }), SKILL, deps)).toEqual({
      ok: false,
      reason: "not-a-team-admin",
    });
    noStoreCalls(deps);
  });

  it("a project user's forged context write gets S1's refusal", async () => {
    const { deps } = harness({
      grants: { teamIds: [], projectGrants: [{ projectId: PROJECT, effectiveRole: "write", accessSource: "user" }] },
    });
    const target = agentAt({ kind: "project", id: PROJECT });
    expect(await assignScopeContextArtifact(target, SLOT.slotId, "res_kit", deps)).toEqual({ ok: false, reason: "not-a-project-admin" });
    expect(await removeScopeContextArtifact(target, SLOT.slotId, "res_kit", deps)).toEqual({ ok: false, reason: "not-a-project-admin" });
    expect(await reorderScopeContextArtifacts(target, SLOT.slotId, ["res_kit"], deps)).toEqual({ ok: false, reason: "not-a-project-admin" });
    noStoreCalls(deps);
  });

  it("an org member's forged organization write gets S1's refusal", async () => {
    const { deps } = harness({});
    expect(await assignScopeSkill(agentAt({ kind: "organization", id: ORG }), SKILL, deps)).toEqual({
      ok: false,
      reason: "not-an-organization-admin",
    });
    noStoreCalls(deps);
  });

  it("a member's forged workspace write needs the audited bypass and gets S1's refusal", async () => {
    const { deps } = harness({ grants: { orgRole: "org_owner", teamIds: [], projectGrants: [] } });
    expect(
      await assignScopeSkill(agentAt({ kind: "workspace" }, { kind: "workspace" }), SKILL, deps),
    ).toEqual({ ok: false, reason: "workspace-requires-audited-bypass" });
    expect(deps.bypass).not.toHaveBeenCalled();
    noStoreCalls(deps);
  });

  it("an org admin's forged write into a sealed-room project they hold no grant on is refused", async () => {
    const { deps } = harness({ grants: { orgRole: "org_admin", teamIds: [], projectGrants: [] } });
    // The project page itself does not resolve for this reader; on the
    // workspace page the project section is not shown, so the write names a
    // scope the page does not carry.
    expect(await assignScopeSkill(agentAt({ kind: "project", id: PROJECT }), SKILL, deps)).toEqual({ ok: false, reason: "not-found" });
    expect(
      await assignScopeSkill(agentAt({ kind: "workspace" }, { kind: "project", id: PROJECT }), SKILL, deps),
    ).toEqual({ ok: false, reason: "scope-not-on-this-page" });
    noStoreCalls(deps);
  });

  it("a forged package pair is not found, and a forged section is not on this page", async () => {
    const { deps } = harness({ grants: { orgRole: "org_admin", teamIds: [], projectGrants: [] } });
    expect(
      await assignScopeSkill({ ...agentAt({ kind: "organization", id: ORG }), name: "not-installed" }, SKILL, deps),
    ).toEqual({ ok: false, reason: "not-found" });
    expect(
      await assignScopeSkill(agentAt({ kind: "organization", id: ORG }, { kind: "team", id: TEAM }), SKILL, deps),
    ).toEqual({ ok: false, reason: "scope-not-on-this-page" });
    noStoreCalls(deps);
  });

  it("refuses a malformed action input without throwing", async () => {
    const { deps } = harness({});
    for (const junk of [null, undefined, {}, { surface: "agent" }, { surface: "agent", scope: { kind: "team" }, vendor: "cinatra-ai", name: "scope-fixture-agent" }]) {
      expect(await assignScopeSkill(junk as never, SKILL, deps)).toEqual({ ok: false, reason: "not-found" });
    }
    noStoreCalls(deps);
  });

  it("S1's assignment-target admission refusal is surfaced and nothing is written", async () => {
    const { deps } = harness({ admission: { ok: false, reason: "eligibility-unreadable" } });
    expect(await assignScopeSkill(agentAt({ kind: "personal" }), SKILL, deps)).toEqual({
      ok: false,
      reason: "eligibility-unreadable",
    });
    noStoreCalls(deps);
  });
});

describe("allowed writes issue the exact scope tuple", () => {
  it("personal self assigns and removes at the user's own tuple", async () => {
    const { deps } = harness({});
    expect(await assignScopeSkill(agentAt({ kind: "personal" }), SKILL, deps)).toEqual({ ok: true });
    expect(deps.insertSkill).toHaveBeenCalledWith({
      agentPackageName: PKG,
      skillId: SKILL,
      createdBy: ME,
      scope: { scopeKind: "user", scopeId: ME },
    });
    expect(deps.withInstallLock).toHaveBeenCalledWith("@cinatra-ai/blog-skills", expect.any(Function));
    expect(await removeScopeSkill(agentAt({ kind: "personal" }), SKILL, deps)).toEqual({ ok: true });
    expect(deps.deleteSkill).toHaveBeenCalledWith({
      agentPackageName: PKG,
      skillId: SKILL,
      scope: { scopeKind: "user", scopeId: ME },
    });
    expect(deps.bypass).not.toHaveBeenCalled();
  });

  it("the personal scope is always the caller's own: another user's session writes its own tuple", async () => {
    const { deps } = harness({ userId: OTHER });
    await assignScopeSkill(agentAt({ kind: "personal" }), SKILL, deps);
    expect(deps.insertSkill).toHaveBeenCalledWith(expect.objectContaining({ scope: { scopeKind: "user", scopeId: OTHER } }));
  });

  it("a team admin writes the team tuple", async () => {
    const { deps } = harness({ grants: { teamIds: [TEAM], teamRoles: { [TEAM]: "team_admin" }, projectGrants: [] } });
    expect(await assignScopeSkill(agentAt({ kind: "team", id: TEAM }), SKILL, deps)).toEqual({ ok: true });
    expect(deps.insertSkill).toHaveBeenCalledWith(expect.objectContaining({ scope: { scopeKind: "team", scopeId: TEAM } }));
  });

  it("the workspace editor writes the org tuple for an org admin, from the org section", async () => {
    const { deps } = harness({ grants: { orgRole: "org_admin", teamIds: [], projectGrants: [] } });
    expect(
      await assignScopeSkill(agentAt({ kind: "workspace" }, { kind: "organization", id: ORG }), SKILL, deps),
    ).toEqual({ ok: true });
    expect(deps.insertSkill).toHaveBeenCalledWith(expect.objectContaining({ scope: { scopeKind: "organization", scopeId: ORG } }));
  });

  it("surfaces the cap and a skill that stopped being assignable", async () => {
    const capped = harness({});
    capped.deps.insertSkill = vi.fn(async () => ({ outcome: "cap_exceeded", count: 5 }) as const);
    expect(await assignScopeSkill(agentAt({ kind: "personal" }), SKILL, capped.deps)).toEqual({ ok: false, reason: "cap-exceeded" });

    const archived = harness({});
    archived.deps.resolveAssignability = vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, assignable(id, false)])));
    expect(await assignScopeSkill(agentAt({ kind: "personal" }), SKILL, archived.deps)).toEqual({ ok: false, reason: "not-assignable" });
    expect(archived.deps.insertSkill).not.toHaveBeenCalled();
  });
});

describe("the audited platform-admin path", () => {
  it("writes the workspace tuple only after the workspace_configuration audit row", async () => {
    const { deps, events } = harness({ platformAdmin: true });
    expect(await assignScopeSkill(agentAt({ kind: "workspace" }, { kind: "workspace" }), SKILL, deps)).toEqual({ ok: true });
    expect(events).toEqual(["audit:workspace_configuration", "store:insertSkill"]);
    expect(deps.bypass).toHaveBeenCalledWith(
      expect.objectContaining({ platformRole: "platform_admin" }),
      SCOPE_ASSIGNMENT_AUDIT_OPERATION.skills,
      expect.objectContaining({ resourceType: "agent", resourceId: PKG, ownerId: WORKSPACE_SCOPE_SENTINEL }),
      "workspace_configuration",
      expect.objectContaining({ scopeKind: "workspace", scopeId: WORKSPACE_SCOPE_SENTINEL, skillId: SKILL }),
    );
    expect(deps.insertSkill).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { scopeKind: "workspace", scopeId: WORKSPACE_SCOPE_SENTINEL } }),
    );
  });

  it("writes a team tuple through scope_configuration when the platform admin holds no team role", async () => {
    const { deps, events } = harness({ platformAdmin: true, grants: { teamIds: [TEAM], teamRoles: { [TEAM]: "member" }, projectGrants: [] } });
    expect(await removeScopeSkill(agentAt({ kind: "team", id: TEAM }), SKILL, deps)).toEqual({ ok: true });
    expect(events).toEqual(["audit:scope_configuration", "store:deleteSkill"]);
    expect(deps.bypass).toHaveBeenCalledWith(
      expect.anything(),
      SCOPE_ASSIGNMENT_AUDIT_OPERATION.skills,
      expect.objectContaining({ organizationId: ORG, ownerId: TEAM }),
      "scope_configuration",
      expect.objectContaining({ scopeKind: "team", scopeId: TEAM }),
    );
  });

  it("aborts the write when the audit row cannot be written", async () => {
    const { deps } = harness({ platformAdmin: true, auditFails: true });
    expect(await assignScopeSkill(agentAt({ kind: "workspace" }, { kind: "workspace" }), SKILL, deps)).toEqual({
      ok: false,
      reason: "audit-failed",
    });
    expect(deps.insertSkill).not.toHaveBeenCalled();
  });

  it("never audits a search", async () => {
    const { deps } = harness({ platformAdmin: true });
    const result = await searchScopeSkills(agentAt({ kind: "workspace" }, { kind: "workspace" }), "", { offset: 0, limit: 20 }, deps);
    expect(result.ok).toBe(true);
    expect(deps.bypass).not.toHaveBeenCalled();
  });
});

describe("the Artifacts pane's writes (agents only)", () => {
  const PERSONAL = agentAt({ kind: "personal" });

  it("adds an artifact at the exact tuple after the store's three checks pass", async () => {
    const { deps } = harness({});
    expect(await assignScopeContextArtifact(PERSONAL, SLOT.slotId, "res_kit", deps)).toEqual({ ok: true });
    expect(deps.insertContext).toHaveBeenCalledWith(
      {
        agentPackageName: PKG,
        slotId: SLOT.slotId,
        artifactId: "res_kit",
        scope: { scopeKind: "user", scopeId: ME },
        createdBy: ME,
      },
      expect.objectContaining({
        slotExists: expect.any(Function),
        artifactVisibleToWriter: expect.any(Function),
        slotAcceptsArtifact: expect.any(Function),
      }),
    );
  });

  it("surfaces the typed refusals: an undeclared slot, an invisible artifact, a wrong kind, an unreadable manifest", async () => {
    expect(await assignScopeContextArtifact(PERSONAL, "not-a-slot", "res_kit", harness({}).deps)).toEqual({
      ok: false,
      reason: "unknown-slot",
    });
    expect(
      await assignScopeContextArtifact(PERSONAL, SLOT.slotId, "res_hidden", harness({ artifact: { visible: false, extensions: [] } }).deps),
    ).toEqual({ ok: false, reason: "artifact-not-visible" });
    expect(
      await assignScopeContextArtifact(
        PERSONAL,
        SLOT.slotId,
        "res_post",
        harness({ artifact: { visible: true, extensions: ["@cinatra-ai/blog-post-artifact"] } }).deps,
      ),
    ).toEqual({ ok: false, reason: "incompatible-artifact" });
    expect(await assignScopeContextArtifact(PERSONAL, SLOT.slotId, "res_kit", harness({ slots: "unreadable" }).deps)).toEqual({
      ok: false,
      reason: "validation-unreadable",
    });
  });

  it("removes and reorders at the exact tuple", async () => {
    const { deps } = harness({});
    expect(await removeScopeContextArtifact(PERSONAL, SLOT.slotId, "res_kit", deps)).toEqual({ ok: true });
    expect(deps.deleteContext).toHaveBeenCalledWith({
      agentPackageName: PKG,
      slotId: SLOT.slotId,
      artifactId: "res_kit",
      scope: { scopeKind: "user", scopeId: ME },
    });
    expect(await reorderScopeContextArtifacts(PERSONAL, SLOT.slotId, ["res_b", "res_a"], deps)).toEqual({ ok: true });
    expect(deps.reorderContext).toHaveBeenCalledWith({
      agentPackageName: PKG,
      slotId: SLOT.slotId,
      scope: { scopeKind: "user", scopeId: ME },
      orderedArtifactIds: ["res_b", "res_a"],
    });
  });

  it("passes a long order through whole: storage is uncapped, so a 501-row slot still reorders", async () => {
    const { deps } = harness({});
    const ids = Array.from({ length: 501 }, (_, i) => `res_${i}`);
    expect(await reorderScopeContextArtifacts(PERSONAL, SLOT.slotId, ids, deps)).toEqual({ ok: true });
    expect(deps.reorderContext).toHaveBeenCalledWith(expect.objectContaining({ orderedArtifactIds: ids }));
  });

  it("surfaces a stale order", async () => {
    const { deps } = harness({});
    deps.reorderContext = vi.fn(async () => ({ outcome: "stale-order" }) as const);
    expect(await reorderScopeContextArtifacts(PERSONAL, SLOT.slotId, ["res_a"], deps)).toEqual({ ok: false, reason: "stale-order" });
    expect(await reorderScopeContextArtifacts(PERSONAL, SLOT.slotId, [], deps)).toEqual({ ok: false, reason: "stale-order" });
  });

  it("offers only artifacts the actor can see, of a kind the slot takes, minus the ones already chosen", async () => {
    const { deps } = harness({});
    deps.reads.readAssignedContext = vi.fn(async () => []);
    const result = await searchScopeContextArtifacts(PERSONAL, SLOT.slotId, "", { offset: 0, limit: 20 }, deps);
    expect(result).toEqual({
      ok: true,
      results: [{ artifactId: "res_kit", title: "Brand Kit 2026", kindLabel: "Brand Kit" }],
      hasMore: false,
    });
    expect(deps.reads.listArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG, extensionPackageName: "@cinatra-ai/brand-kit-artifact", projectId: null }),
    );
  });

  it("keeps a project's artifact inside its project: not offered, not admitted at a broader scope", async () => {
    const bound = { artifactId: "res_sealed", title: "Sealed Brief", eligibleExtensions: ["@cinatra-ai/brand-kit-artifact"], primaryExtension: null, projectId: PROJECT };
    const unbound = { artifactId: "res_open", title: "Open Kit", eligibleExtensions: ["@cinatra-ai/brand-kit-artifact"], primaryExtension: null, projectId: null };

    // The organization page (an org admin) is offered the unbound artifact only.
    const org = harness({ grants: { orgRole: "org_admin", teamIds: [], projectGrants: [{ projectId: PROJECT, effectiveRole: "admin", accessSource: "user" }] } });
    org.deps.reads.listArtifacts = vi.fn(async () => [bound, unbound]);
    org.deps.reads.readArtifact = vi.fn(async ({ artifactId }: { artifactId: string }) => ({
      kind: "ok" as const,
      artifact: artifactId === bound.artifactId ? bound : unbound,
    }));
    const offered = await searchScopeContextArtifacts(agentAt({ kind: "organization", id: ORG }), SLOT.slotId, "", { offset: 0, limit: 20 }, org.deps);
    expect(offered.ok && offered.results.map((r) => r.artifactId)).toEqual(["res_open"]);
    // A forged add of the project's artifact at the organization is refused.
    expect(
      await assignScopeContextArtifact(agentAt({ kind: "organization", id: ORG }), SLOT.slotId, bound.artifactId, org.deps),
    ).toEqual({ ok: false, reason: "artifact-not-visible" });
    expect(org.deps.insertContext).not.toHaveBeenCalled();

    // The project's own page takes it.
    const proj = harness({ grants: { teamIds: [], projectGrants: [{ projectId: PROJECT, effectiveRole: "admin", accessSource: "user" }] } });
    proj.deps.reads.listArtifacts = vi.fn(async () => [bound, unbound]);
    proj.deps.reads.readArtifact = org.deps.reads.readArtifact;
    const inProject = await searchScopeContextArtifacts(agentAt({ kind: "project", id: PROJECT }), SLOT.slotId, "", { offset: 0, limit: 20 }, proj.deps);
    expect(inProject.ok && inProject.results.map((r) => r.artifactId).sort()).toEqual(["res_open", "res_sealed"]);
    expect(
      await assignScopeContextArtifact(agentAt({ kind: "project", id: PROJECT }), SLOT.slotId, bound.artifactId, proj.deps),
    ).toEqual({ ok: true });
  });

  it("offers a project page its own project's artifacts AND unbound ones, even where the listing applies the sealed-room filter", async () => {
    const bound = { artifactId: "res_sealed", title: "Sealed Brief", eligibleExtensions: ["@cinatra-ai/brand-kit-artifact"], primaryExtension: null, projectId: PROJECT };
    const unbound = { artifactId: "res_open", title: "Open Kit", eligibleExtensions: ["@cinatra-ai/brand-kit-artifact"], primaryExtension: null, projectId: null };
    const other = { artifactId: "res_other", title: "Other Project", eligibleExtensions: ["@cinatra-ai/brand-kit-artifact"], primaryExtension: null, projectId: "proj_other" };
    const proj = harness({ grants: { teamIds: [], projectGrants: [{ projectId: PROJECT, effectiveRole: "admin", accessSource: "user" }] } });
    // The production listing narrows to `project_id = $projectId` when handed
    // a project; handed none it lists every visible row.
    proj.deps.reads.listArtifacts = vi.fn(async ({ projectId }: { projectId: string | null }) =>
      projectId ? [bound, unbound, other].filter((a) => a.projectId === projectId) : [bound, unbound, other],
    );
    const offered = await searchScopeContextArtifacts(agentAt({ kind: "project", id: PROJECT }), SLOT.slotId, "", { offset: 0, limit: 20 }, proj.deps);
    expect(offered.ok && offered.results.map((r) => r.artifactId).sort()).toEqual(["res_open", "res_sealed"]);
  });

  it("refuses every artifact action on an assistant", async () => {
    const { deps } = harness({});
    const assistant: ScopeAssignmentActionTarget = { surface: "assistant", scope: { kind: "personal" }, vendor: "cinatra-ai", name: "support" };
    expect(await assignScopeContextArtifact(assistant, SLOT.slotId, "res_kit", deps)).toEqual({ ok: false, reason: "assistants-take-skills-only" });
    expect(await removeScopeContextArtifact(assistant, SLOT.slotId, "res_kit", deps)).toEqual({ ok: false, reason: "assistants-take-skills-only" });
    expect(await reorderScopeContextArtifacts(assistant, SLOT.slotId, ["res_kit"], deps)).toEqual({ ok: false, reason: "assistants-take-skills-only" });
    expect(await searchScopeContextArtifacts(assistant, SLOT.slotId, "", { offset: 0, limit: 20 }, deps)).toEqual({ ok: false, reason: "assistants-take-skills-only" });
    noStoreCalls(deps);
    // Skills stay open to an assistant.
    expect(await assignScopeSkill(assistant, SKILL, deps)).toEqual({ ok: true });
    expect(deps.insertSkill).toHaveBeenCalledWith(expect.objectContaining({ agentPackageName: "@cinatra-ai/support-assistant" }));
  });

  it("audits a platform admin's artifact write only once the store's checks pass", async () => {
    const refused = harness({ platformAdmin: true, artifact: { visible: false, extensions: [] } });
    expect(
      await assignScopeContextArtifact(agentAt({ kind: "workspace" }, { kind: "workspace" }), SLOT.slotId, "res_x", refused.deps),
    ).toEqual({ ok: false, reason: "artifact-not-visible" });
    expect(refused.deps.bypass).not.toHaveBeenCalled();

    const allowed = harness({ platformAdmin: true });
    expect(
      await assignScopeContextArtifact(agentAt({ kind: "workspace" }, { kind: "workspace" }), SLOT.slotId, "res_kit", allowed.deps),
    ).toEqual({ ok: true });
    expect(allowed.events).toEqual(["audit:workspace_configuration", "store:insertContext"]);
    expect(allowed.deps.bypass).toHaveBeenCalledWith(
      expect.anything(),
      SCOPE_ASSIGNMENT_AUDIT_OPERATION.context,
      expect.anything(),
      "workspace_configuration",
      expect.objectContaining({ slotId: SLOT.slotId, artifactId: "res_kit" }),
    );
  });
});
