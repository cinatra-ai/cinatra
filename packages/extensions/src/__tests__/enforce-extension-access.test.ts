import { describe, it, expect } from "vitest";

import {
  evaluateExtensionAccess,
  type EvaluateExtensionAccessInput,
  type ExtensionOwnerContext,
} from "../enforce-extension-access";
import type { ActorContext } from "@/lib/authz";
import type {
  AgentAuthPolicy,
  AgentAuthPolicyVisibility,
  AgentAuthPolicyVisibilitySelection,
} from "@cinatra-ai/agents/auth-policy";

// ---------------------------------------------------------------------------
// Pure evaluator coverage. No I/O — exercises the access
// decision matrix directly. The owner-aware "admin" tier is the
// load-bearing divergence from the agent run path's policyAllows().
// ---------------------------------------------------------------------------

const ORG = "org-1";
const OTHER_ORG = "org-2";

function human(
  id: string,
  opts: Partial<ActorContext> = {},
): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: id,
    organizationId: ORG,
    authSource: "ui",
    policyVersion: "v2",
    ...opts,
  };
}

const orgOwnerCtx: ExtensionOwnerContext = {
  ownerLevel: "organization",
  ownerId: ORG,
  organizationId: ORG,
};

// Multi-scope W1: each visibility field is a token array. This builder accepts
// a scalar token OR an array per field (keeping the many single-token call
// sites terse) and coerces to the canonical array shape.
type VisArg = AgentAuthPolicyVisibility | AgentAuthPolicyVisibilitySelection;
function policy(
  over: {
    runListVisibility?: VisArg;
    runDataVisibility?: VisArg;
    runExecuteVisibility?: VisArg;
    allowRunSharing?: boolean;
    description?: string;
  } = {},
): AgentAuthPolicy {
  const sel = (
    v: VisArg | undefined,
    fallback: AgentAuthPolicyVisibility,
  ): AgentAuthPolicyVisibilitySelection =>
    v === undefined ? [fallback] : Array.isArray(v) ? v : [v];
  return {
    runListVisibility: sel(over.runListVisibility, "workspace"),
    runDataVisibility: sel(over.runDataVisibility, "workspace"),
    runExecuteVisibility: sel(over.runExecuteVisibility, "workspace"),
    allowRunSharing: over.allowRunSharing ?? false,
    ...(over.description !== undefined ? { description: over.description } : {}),
  };
}

function base(over: Partial<EvaluateExtensionAccessInput> = {}): EvaluateExtensionAccessInput {
  return {
    policy: policy(),
    coOwnerUserIds: [],
    installedByUserId: null,
    owner: orgOwnerCtx,
    actor: human("member-user", { orgRole: "member" }),
    op: "read",
    ...over,
  };
}

describe("evaluateExtensionAccess — basics", () => {
  it("denies a missing actor", () => {
    expect(evaluateExtensionAccess(base({ actor: undefined }))).toEqual({
      allowed: false,
      reason: "no_actor",
    });
  });

  it("platform_admin bypasses every gate", () => {
    const actor = human("pa", { platformRole: "platform_admin", orgRole: "member" });
    for (const op of ["list", "read", "use", "execute", "share", "manage"] as const) {
      expect(evaluateExtensionAccess(base({ actor, op, policy: policy({ runDataVisibility: "owner" }) })).allowed).toBe(true);
    }
  });

  it("denies a different-org actor (cross-org guard)", () => {
    const actor = human("cross", { organizationId: OTHER_ORG, orgRole: "org_admin" });
    expect(evaluateExtensionAccess(base({ actor, op: "read" }))).toEqual({
      allowed: false,
      reason: "cross_org",
    });
  });
});

describe("evaluateExtensionAccess — visibility tiers", () => {
  it("workspace tier: any same-org member can read/use/execute", () => {
    const actor = human("m", { orgRole: "member" });
    for (const op of ["list", "read", "use", "execute"] as const) {
      expect(evaluateExtensionAccess(base({ actor, op })).allowed).toBe(true);
    }
  });

  it("owner tier: a non-owner member is denied", () => {
    const actor = human("m", { orgRole: "member" });
    expect(
      evaluateExtensionAccess(base({ actor, policy: policy({ runDataVisibility: "owner" }) })).allowed,
    ).toBe(false);
  });

  it("team: tier honours actor.teamIds", () => {
    const allowed = human("m", { orgRole: "member", teamIds: ["team-9"] });
    const denied = human("m2", { orgRole: "member", teamIds: ["team-x"] });
    const p = policy({ runDataVisibility: "team:team-9" });
    expect(evaluateExtensionAccess(base({ actor: allowed, policy: p })).allowed).toBe(true);
    expect(evaluateExtensionAccess(base({ actor: denied, policy: p })).allowed).toBe(false);
  });

  it("project: tier honours actor.projectIds", () => {
    const allowed = human("m", { orgRole: "member", projectIds: ["p-1"] });
    const denied = human("m2", { orgRole: "member", projectIds: [] });
    const p = policy({ runDataVisibility: "project:p-1" });
    expect(evaluateExtensionAccess(base({ actor: allowed, policy: p })).allowed).toBe(true);
    expect(evaluateExtensionAccess(base({ actor: denied, policy: p })).allowed).toBe(false);
  });
});

describe("evaluateExtensionAccess — owner-aware admin tier", () => {
  const adminPolicy = policy({
    runListVisibility: "admin",
    runDataVisibility: "admin",
    runExecuteVisibility: "admin",
  });

  it("org_admin of the OWNING org is allowed on an org-owned extension", () => {
    const actor = human("oa", { orgRole: "org_admin" });
    expect(evaluateExtensionAccess(base({ actor, policy: adminPolicy, op: "read" })).allowed).toBe(true);
    expect(evaluateExtensionAccess(base({ actor, policy: adminPolicy, op: "use" })).allowed).toBe(true);
  });

  it("org_owner of the OWNING org is allowed", () => {
    const actor = human("oo", { orgRole: "org_owner" });
    expect(evaluateExtensionAccess(base({ actor, policy: adminPolicy, op: "read" })).allowed).toBe(true);
  });

  it("a plain member of the owning org is DENIED on an admin-visibility extension", () => {
    const actor = human("m", { orgRole: "member" });
    expect(evaluateExtensionAccess(base({ actor, policy: adminPolicy, op: "read" }))).toEqual({
      allowed: false,
      reason: "not_visible",
    });
  });

  it("an org_admin of a DIFFERENT org is denied (cross-org wins)", () => {
    const actor = human("oa", { organizationId: OTHER_ORG, orgRole: "org_admin" });
    expect(evaluateExtensionAccess(base({ actor, policy: adminPolicy, op: "read" }))).toEqual({
      allowed: false,
      reason: "cross_org",
    });
  });

  it("for a USER-owned extension, admin tier excludes a non-owner org_admin (only owner/platform-admin)", () => {
    const userOwner: ExtensionOwnerContext = {
      ownerLevel: "user",
      ownerId: "owner-user",
      organizationId: null,
    };
    const orgAdmin = human("oa", { orgRole: "org_admin", organizationId: ORG });
    expect(
      evaluateExtensionAccess(base({ owner: userOwner, actor: orgAdmin, policy: adminPolicy, op: "read" })).allowed,
    ).toBe(false);
  });
});

describe("evaluateExtensionAccess — owner / co-owner short-circuit", () => {
  it("installer can read even with owner-only visibility", () => {
    const actor = human("installer", { orgRole: "member" });
    expect(
      evaluateExtensionAccess(
        base({ actor, installedByUserId: "installer", policy: policy({ runDataVisibility: "owner" }) }),
      ).allowed,
    ).toBe(true);
  });

  it("co-owner can read even with admin-only visibility", () => {
    const actor = human("co", { orgRole: "member" });
    expect(
      evaluateExtensionAccess(
        base({ actor, coOwnerUserIds: ["co"], policy: policy({ runDataVisibility: "admin" }) }),
      ).allowed,
    ).toBe(true);
  });

  it("user-owned: the owning user matches via ownerId", () => {
    const userOwner: ExtensionOwnerContext = {
      ownerLevel: "user",
      ownerId: "owner-user",
      organizationId: null,
    };
    const actor = human("owner-user", { orgRole: "member", organizationId: undefined });
    expect(
      evaluateExtensionAccess(base({ owner: userOwner, actor, policy: policy({ runDataVisibility: "owner" }) })).allowed,
    ).toBe(true);
  });
});

describe("evaluateExtensionAccess — manage op", () => {
  it("plain member cannot manage", () => {
    const actor = human("m", { orgRole: "member" });
    expect(evaluateExtensionAccess(base({ actor, op: "manage" }))).toEqual({
      allowed: false,
      reason: "manage_requires_admin",
    });
  });

  it("org_admin of owning org can manage", () => {
    const actor = human("oa", { orgRole: "org_admin" });
    expect(evaluateExtensionAccess(base({ actor, op: "manage" })).allowed).toBe(true);
  });

  it("installer can manage their own extension", () => {
    const actor = human("installer", { orgRole: "member" });
    expect(evaluateExtensionAccess(base({ actor, op: "manage", installedByUserId: "installer" })).allowed).toBe(true);
  });

  it("co-owner can manage", () => {
    const actor = human("co", { orgRole: "member" });
    expect(evaluateExtensionAccess(base({ actor, op: "manage", coOwnerUserIds: ["co"] })).allowed).toBe(true);
  });
});

describe("evaluateExtensionAccess — share op", () => {
  it("share denied when allowRunSharing=false for a plain member", () => {
    const actor = human("m", { orgRole: "member" });
    expect(evaluateExtensionAccess(base({ actor, op: "share", policy: policy({ allowRunSharing: false }) }))).toEqual({
      allowed: false,
      reason: "not_visible",
    });
  });

  it("share allowed for org_admin even when allowRunSharing=false", () => {
    const actor = human("oa", { orgRole: "org_admin" });
    expect(
      evaluateExtensionAccess(base({ actor, op: "share", policy: policy({ allowRunSharing: false }) })).allowed,
    ).toBe(true);
  });

  it("share follows runDataVisibility when allowRunSharing=true", () => {
    const actor = human("m", { orgRole: "member" });
    expect(
      evaluateExtensionAccess(
        base({ actor, op: "share", policy: policy({ allowRunSharing: true, runDataVisibility: "workspace" }) }),
      ).allowed,
    ).toBe(true);
  });

  it("co-owner can share even when allowRunSharing=false (share ∈ COOWNER_OPS)", () => {
    const actor = human("co", { orgRole: "member" });
    expect(
      evaluateExtensionAccess(
        base({ actor, op: "share", coOwnerUserIds: ["co"], policy: policy({ allowRunSharing: false }) }),
      ).allowed,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hardening: org-less actor fail-closed (cross-org guard),
// admin does NOT bypass team/project tiers, unknown visibility fails closed.
// ---------------------------------------------------------------------------

describe("evaluateExtensionAccess — org-less actor on an org-owned extension (fail closed)", () => {
  const orgLess = human("worker", { organizationId: undefined, orgRole: "member" });

  it("denies read/use/execute/share/manage when actor has no organizationId", () => {
    for (const op of ["read", "use", "execute", "share", "manage"] as const) {
      expect(evaluateExtensionAccess(base({ actor: orgLess, op }))).toEqual({
        allowed: false,
        reason: "cross_org",
      });
    }
  });

  it("denies even an org-less installer / co-owner (guard runs before short-circuit)", () => {
    expect(
      evaluateExtensionAccess(base({ actor: orgLess, op: "read", installedByUserId: "worker" })).allowed,
    ).toBe(false);
    expect(
      evaluateExtensionAccess(base({ actor: orgLess, op: "read", coOwnerUserIds: ["worker"] })).allowed,
    ).toBe(false);
  });
});

describe("evaluateExtensionAccess — admin does NOT over-broaden", () => {
  it("an owning-org admin is NOT auto-allowed on a team:-restricted extension they aren't on", () => {
    const orgAdmin = human("oa", { orgRole: "org_admin", teamIds: [] });
    expect(
      evaluateExtensionAccess(base({ actor: orgAdmin, op: "read", policy: policy({ runDataVisibility: "team:team-9" }) }))
        .allowed,
    ).toBe(false);
  });

  it("an owning-org admin IS allowed on an admin-tier extension (owner-aware)", () => {
    const orgAdmin = human("oa", { orgRole: "org_admin" });
    expect(
      evaluateExtensionAccess(base({ actor: orgAdmin, op: "read", policy: policy({ runDataVisibility: "admin" }) }))
        .allowed,
    ).toBe(true);
  });
});

describe("evaluateExtensionAccess — unknown visibility fails closed", () => {
  it("denies a member when the stored visibility is an unrecognized value", () => {
    const actor = human("m", { orgRole: "member" });
    const bogus = { ...policy(), runDataVisibility: "galaxy:42" } as unknown as ReturnType<typeof policy>;
    expect(evaluateExtensionAccess(base({ actor, op: "read", policy: bogus }))).toEqual({
      allowed: false,
      reason: "not_visible",
    });
  });
});
