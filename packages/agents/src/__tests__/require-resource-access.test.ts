// requireResourceAccess + buildScopeReason decision matrix regression coverage.

import { describe, it, expect } from "vitest";
import type { ActorContext } from "@/lib/authz";
import { requireResourceAccess, buildScopeReason, buildSkillResourceRef } from "../auth-policy";
import type { SkillResourceRef } from "../auth-policy";

// ---------------------------------------------------------------------------
// requireResourceAccess
// ---------------------------------------------------------------------------

describe("requireResourceAccess", () => {
  // system × 2
  it("allows platform_admin on system-level resource", () => {
    const actor = { platformRole: "platform_admin", principalId: "p1" } as unknown as ActorContext;
    expect(() =>
      requireResourceAccess(actor, {
        resourceType: "skill",
        resourceId: "x",
        level: "system",
      }),
    ).not.toThrow();
  });

  it("throws 404 hidden for non-admin on system-level resource", () => {
    const actor = { platformRole: "user", principalId: "p1" } as unknown as ActorContext;
    expect(() =>
      requireResourceAccess(actor, {
        resourceType: "skill",
        resourceId: "x",
        level: "system",
      }),
    ).toThrow(expect.objectContaining({ statusCode: 404, reason: "hidden" }));
  });

  // organization × 2
  it("allows actor when organizationId matches resource.organizationId", () => {
    const actor = {
      platformRole: "user",
      principalId: "p1",
      organizationId: "org-1",
    } as unknown as ActorContext;
    expect(() =>
      requireResourceAccess(actor, {
        resourceType: "skill",
        resourceId: "x",
        level: "organization",
        organizationId: "org-1",
      }),
    ).not.toThrow();
  });

  it("throws 403 when organizationId mismatches", () => {
    const actor = {
      platformRole: "user",
      principalId: "p1",
      organizationId: "org-2",
    } as unknown as ActorContext;
    expect(() =>
      requireResourceAccess(actor, {
        resourceType: "skill",
        resourceId: "x",
        level: "organization",
        organizationId: "org-1",
      }),
    ).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  // team × 2
  it("allows team member on team-scoped resource", () => {
    const actor = {
      platformRole: "user",
      principalId: "p1",
      teamIds: ["team-1"],
    } as unknown as ActorContext;
    expect(() =>
      requireResourceAccess(actor, {
        resourceType: "skill",
        resourceId: "x",
        level: "team",
        ownerId: "team-1",
      }),
    ).not.toThrow();
  });

  it("throws 403 for non-member on team-scoped resource", () => {
    const actor = {
      platformRole: "user",
      principalId: "p1",
      teamIds: ["team-2"],
    } as unknown as ActorContext;
    expect(() =>
      requireResourceAccess(actor, {
        resourceType: "skill",
        resourceId: "x",
        level: "team",
        ownerId: "team-1",
      }),
    ).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  // project × 2
  it("allows project member on project-scoped resource", () => {
    const actor = {
      platformRole: "user",
      principalId: "p1",
      projectIds: ["proj-1"],
    } as unknown as ActorContext;
    expect(() =>
      requireResourceAccess(actor, {
        resourceType: "skill",
        resourceId: "x",
        level: "project",
        ownerId: "proj-1",
      }),
    ).not.toThrow();
  });

  it("throws 403 for non-member on project-scoped resource", () => {
    const actor = {
      platformRole: "user",
      principalId: "p1",
      projectIds: ["proj-2"],
    } as unknown as ActorContext;
    expect(() =>
      requireResourceAccess(actor, {
        resourceType: "skill",
        resourceId: "x",
        level: "project",
        ownerId: "proj-1",
      }),
    ).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  // workspace × 2
  it("allows org_admin on workspace-scoped resource", () => {
    const actor = {
      platformRole: "user",
      principalId: "p1",
      organizationId: "org-1",
      orgRole: "org_admin",
    } as unknown as ActorContext;
    expect(() =>
      requireResourceAccess(actor, {
        resourceType: "skill",
        resourceId: "x",
        level: "workspace",
      }),
    ).not.toThrow();
  });

  // "Workspace: All" means every workspace user can READ a workspace
  // resource; only admins/owners may MANAGE it.
  it("allows member role to READ a workspace-scoped resource (read mode = default)", () => {
    const actor = {
      platformRole: "user",
      principalId: "p1",
      organizationId: "org-1",
      orgRole: "member",
    } as unknown as ActorContext;
    expect(() =>
      requireResourceAccess(actor, {
        resourceType: "skill",
        resourceId: "x",
        level: "workspace",
      }),
    ).not.toThrow();
  });

  it("throws 403 for member role MANAGING a workspace-scoped resource", () => {
    const actor = {
      platformRole: "user",
      principalId: "p1",
      orgRole: "member",
    } as unknown as ActorContext;
    expect(() =>
      requireResourceAccess(
        actor,
        { resourceType: "skill", resourceId: "x", level: "workspace" },
        "manage",
      ),
    ).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  it("allows org_admin to MANAGE a workspace-scoped resource", () => {
    const actor = {
      platformRole: "user",
      principalId: "p1",
      organizationId: "org-1",
      orgRole: "org_admin",
    } as unknown as ActorContext;
    expect(() =>
      requireResourceAccess(
        actor,
        { resourceType: "skill", resourceId: "x", level: "workspace" },
        "manage",
      ),
    ).not.toThrow();
  });

  // An org-less / identity-less actor MUST be denied workspace read;
  // otherwise the workspace tier becomes a cross-org skill enumeration
  // surface.
  it("denies org-less actor on workspace read (security regression guard)", () => {
    const actor = {
      platformRole: "user",
      principalId: "p1",
      // intentionally no organizationId
    } as unknown as ActorContext;
    expect(() =>
      requireResourceAccess(actor, {
        resourceType: "skill",
        resourceId: "x",
        level: "workspace",
      }),
    ).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  // The narrow F1-closing exception: the roleless buildSkillTools internal
  // model/agent actor reading the chat's OWN system skill is the only
  // org-less workspace read that's allowed (because it IS the chat
  // resolving its own infrastructure prompt). Pins that exact shape.
  it("allows the internal model actor reading the chat assistant skill", () => {
    const actor = {
      platformRole: "user",
      principalType: "ServiceAccount",
      principalId: "system",
      authSource: "mcp",
    } as unknown as ActorContext;
    expect(() =>
      requireResourceAccess(actor, {
        resourceType: "skill",
        resourceId: "@cinatra-ai/chat:chat-assistant-core",
        level: "workspace",
      }),
    ).not.toThrow();
  });

  it("denies the internal model actor reading any OTHER workspace skill", () => {
    const actor = {
      platformRole: "user",
      principalType: "ServiceAccount",
      principalId: "system",
      authSource: "mcp",
    } as unknown as ActorContext;
    expect(() =>
      requireResourceAccess(actor, {
        resourceType: "skill",
        resourceId: "@some-other/workspace:skill",
        level: "workspace",
      }),
    ).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  // owner short-circuit × 1
  it("allows owner via principalId === ownerId short-circuit when no level matched", () => {
    const actor = {
      platformRole: "user",
      principalId: "user-42",
    } as unknown as ActorContext;
    expect(() =>
      requireResourceAccess(actor, {
        resourceType: "skill",
        resourceId: "x",
        // no level → falls through to owner check
        ownerId: "user-42",
      }),
    ).not.toThrow();
  });

  it("throws 403 when no level matched and principalId !== ownerId", () => {
    const actor = {
      platformRole: "user",
      principalId: "user-99",
    } as unknown as ActorContext;
    expect(() =>
      requireResourceAccess(actor, {
        resourceType: "skill",
        resourceId: "x",
        ownerId: "user-42",
      }),
    ).toThrow(expect.objectContaining({ statusCode: 403 }));
  });
});

// ---------------------------------------------------------------------------
// buildScopeReason
// ---------------------------------------------------------------------------

describe("buildScopeReason", () => {
  it("returns null for 'owner'", () => {
    expect(buildScopeReason("owner", {})).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(buildScopeReason(undefined, {})).toBeNull();
  });

  it("returns team copy with teamName interpolated for 'team:<id>'", () => {
    expect(buildScopeReason("team:t1", { teamName: "Acme Team" })).toBe(
      "You can see this because you're a member of Acme Team.",
    );
  });

  it("returns org copy with orgName interpolated for 'org'", () => {
    expect(buildScopeReason("org", { orgName: "Acme Corp" })).toBe(
      "You can see this because you're a member of Acme Corp.",
    );
  });

  it("returns org copy for 'org:<id>' variant", () => {
    expect(buildScopeReason("org:org-1", { orgName: "Acme Corp" })).toBe(
      "You can see this because you're a member of Acme Corp.",
    );
  });

  it("returns project copy with projectName interpolated for 'project:<id>'", () => {
    expect(buildScopeReason("project:p1", { projectName: "Alpha" })).toBe(
      "You can see this because you're part of Alpha.",
    );
  });

  it("returns workspace copy for 'workspace'", () => {
    // "Workspace: All" = every workspace user.
    expect(buildScopeReason("workspace", {})).toBe("Visible to everyone in the workspace.");
  });

  it("returns admin copy for 'admin'", () => {
    expect(buildScopeReason("admin", {})).toBe("Visible to platform admins only.");
  });
});

// ---------------------------------------------------------------------------
// buildSkillResourceRef
// ---------------------------------------------------------------------------
// Locks the contract: every caller MUST source the resource organization
// from the SKILL's owning org (skill.scope) for level:"organization" rows,
// not the caller's org. The previous pattern passed `organizationId: orgId`
// where orgId was the caller's org, making the policy check
// (`actor.organizationId === resource.organizationId`) tautological for
// any org-authenticated caller.

describe("buildSkillResourceRef (cross-org tautology fix)", () => {
  it("level:organization → organizationId comes from skill.scope (the OWNER's org)", () => {
    const ref = buildSkillResourceRef({ id: "sk-1", level: "organization", scope: "org-1" });
    expect(ref.resourceType).toBe("skill");
    expect(ref.resourceId).toBe("sk-1");
    expect(ref.level).toBe("organization");
    expect(ref.ownerId).toBe("org-1");
    expect(ref.organizationId).toBe("org-1");
  });

  it("level:organization with null scope → organizationId undefined (policy denies)", () => {
    const ref = buildSkillResourceRef({ id: "sk-1", level: "organization", scope: null });
    expect(ref.organizationId).toBeUndefined();
  });

  it("level:team → organizationId undefined (only ownerId matters for policy branch)", () => {
    const ref = buildSkillResourceRef({ id: "sk-1", level: "team", scope: "team-A" });
    expect(ref.ownerId).toBe("team-A");
    expect(ref.organizationId).toBeUndefined();
  });

  it("level:project → organizationId undefined", () => {
    const ref = buildSkillResourceRef({ id: "sk-1", level: "project", scope: "proj-X" });
    expect(ref.ownerId).toBe("proj-X");
    expect(ref.organizationId).toBeUndefined();
  });

  it("level:personal → organizationId undefined", () => {
    const ref = buildSkillResourceRef({ id: "sk-1", level: "personal", scope: "user-1" });
    expect(ref.ownerId).toBe("user-1");
    expect(ref.organizationId).toBeUndefined();
  });

  it("level:workspace → organizationId undefined (policy branch ignores resource.organizationId)", () => {
    const ref = buildSkillResourceRef({ id: "sk-1", level: "workspace", scope: null });
    expect(ref.organizationId).toBeUndefined();
  });

  it("level:system → organizationId undefined", () => {
    const ref = buildSkillResourceRef({ id: "sk-1", level: "system", scope: null });
    expect(ref.organizationId).toBeUndefined();
  });

  // Cross-org tautology regression: feeding the builder's result into
  // requireResourceAccess MUST deny a non-admin actor in org-2 trying to
  // read an org-1 skill.
  it("CROSS-ORG REGRESSION: actor org-2 + skill scope org-1 → 403", () => {
    const actor = {
      platformRole: "user",
      principalId: "p1",
      organizationId: "org-2",
    } as unknown as ActorContext;
    const ref = buildSkillResourceRef({ id: "sk-1", level: "organization", scope: "org-1" });
    expect(() => requireResourceAccess(actor, ref)).toThrow(
      expect.objectContaining({ statusCode: 403 }),
    );
  });

  it("CROSS-ORG REGRESSION: actor org-1 + skill scope org-1 → allow", () => {
    const actor = {
      platformRole: "user",
      principalId: "p1",
      organizationId: "org-1",
    } as unknown as ActorContext;
    const ref = buildSkillResourceRef({ id: "sk-1", level: "organization", scope: "org-1" });
    expect(() => requireResourceAccess(actor, ref)).not.toThrow();
  });
});
