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
    // Default to a "most kinds" kind (full admin-standing parity). Kind-specific
    // carve-outs (connection, agent_run) are pinned in their own describe below.
    kind: "skill",
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

  it("an ORG-LESS user-owned extension (organizationId=null) excludes a non-owner org_admin — no org to be admin of", () => {
    const orgLessUserOwner: ExtensionOwnerContext = {
      ownerLevel: "user",
      ownerId: "owner-user",
      organizationId: null,
    };
    const orgAdmin = human("oa", { orgRole: "org_admin", organizationId: ORG });
    expect(
      evaluateExtensionAccess(
        base({ owner: orgLessUserOwner, actor: orgAdmin, policy: adminPolicy, op: "read" }),
      ).allowed,
    ).toBe(false);
  });

  it("an ORG-ANCHORED user-owned extension admits a non-installer org_admin even with OWNER visibility (admin standing)", () => {
    // Post-M1 backfill: an org-anchored user install carries its org on
    // organizationId. A non-installer org_admin gets admin standing regardless
    // of the stored (owner-only) tier — the core of the epic.
    const orgAnchoredUserOwner: ExtensionOwnerContext = {
      ownerLevel: "user",
      ownerId: "some-other-user",
      organizationId: ORG,
    };
    const orgAdmin = human("oa", { orgRole: "org_admin", organizationId: ORG });
    expect(
      evaluateExtensionAccess(
        base({
          owner: orgAnchoredUserOwner,
          actor: orgAdmin,
          policy: policy({ runDataVisibility: "owner" }),
          op: "read",
        }),
      ).allowed,
    ).toBe(true);
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

describe("evaluateExtensionAccess — admin standing short-circuits the visibility tier", () => {
  it("an owning-org admin IS allowed on a team:-restricted extension they aren't on (standing overrides the tier)", () => {
    // NEW CONTRACT (P1): admin standing is role-derived and independent of the
    // stored visibility tier, so a same-org admin is admitted even on a
    // team:-restricted row they are not a member of. (Was denied pre-P1.)
    const orgAdmin = human("oa", { orgRole: "org_admin", teamIds: [] });
    expect(
      evaluateExtensionAccess(base({ actor: orgAdmin, op: "read", policy: policy({ runDataVisibility: "team:team-9" }) }))
        .allowed,
    ).toBe(true);
  });

  it("an owning-org admin IS allowed on an admin-tier extension (owner-aware)", () => {
    const orgAdmin = human("oa", { orgRole: "org_admin" });
    expect(
      evaluateExtensionAccess(base({ actor: orgAdmin, op: "read", policy: policy({ runDataVisibility: "admin" }) }))
        .allowed,
    ).toBe(true);
  });

  it("a DIFFERENT-org admin still does NOT over-broaden (cross-org guard wins)", () => {
    const crossOrgAdmin = human("oa", { organizationId: OTHER_ORG, orgRole: "org_admin", teamIds: [] });
    expect(
      evaluateExtensionAccess(
        base({ actor: crossOrgAdmin, op: "read", policy: policy({ runDataVisibility: "workspace" }) }),
      ),
    ).toEqual({ allowed: false, reason: "cross_org" });
  });
});

// ---------------------------------------------------------------------------
// P1: kind-aware admin-standing short-circuit. A non-installer admin of the
// owning org gets role-derived access to OWNER-default rows (no installer
// pointer needed) — EXCEPT connection use/execute and agent_run run-data.
// ---------------------------------------------------------------------------

describe("evaluateExtensionAccess — kind-aware admin standing (P1)", () => {
  const ownerDefault = policy({
    runListVisibility: "owner",
    runDataVisibility: "owner",
    runExecuteVisibility: "owner",
  });
  const orgAdmin = human("oa", { orgRole: "org_admin" });
  const orgOwner = human("oo", { orgRole: "org_owner" });

  it("most kinds: a non-installer org_admin is allowed on an OWNER-default row for every op", () => {
    for (const op of ["list", "read", "use", "execute", "share", "manage"] as const) {
      expect(
        evaluateExtensionAccess(
          base({ kind: "skill", actor: orgAdmin, op, policy: ownerDefault, installedByUserId: null }),
        ).allowed,
      ).toBe(true);
    }
  });

  it("most kinds: an org_owner too (role-derived, no per-row grant seeded)", () => {
    expect(
      evaluateExtensionAccess(base({ kind: "artifact", actor: orgOwner, op: "use", policy: ownerDefault })).allowed,
    ).toBe(true);
  });

  it("parity holds when the installer pointer is NULL (FK set-null after the installer is deleted)", () => {
    expect(
      evaluateExtensionAccess(
        base({ kind: "skill", actor: orgAdmin, op: "execute", policy: ownerDefault, installedByUserId: null }),
      ).allowed,
    ).toBe(true);
  });

  it("connection: admin standing grants list/read/manage", () => {
    for (const op of ["list", "read", "manage"] as const) {
      expect(
        evaluateExtensionAccess(base({ kind: "connection", actor: orgAdmin, op, policy: ownerDefault })).allowed,
      ).toBe(true);
    }
  });

  it("connection: admin standing does NOT grant use/execute (credential use stays an owner share)", () => {
    for (const op of ["use", "execute"] as const) {
      expect(
        evaluateExtensionAccess(base({ kind: "connection", actor: orgAdmin, op, policy: ownerDefault })),
      ).toEqual({ allowed: false, reason: "not_visible" });
    }
  });

  it("connection: admin standing does NOT grant share on an owner-default connection", () => {
    expect(
      evaluateExtensionAccess(base({ kind: "connection", actor: orgAdmin, op: "share", policy: ownerDefault })).allowed,
    ).toBe(false);
  });

  it("agent_run: admin standing grants manage only; list/read/use/execute/share stay owner-private", () => {
    expect(
      evaluateExtensionAccess(base({ kind: "agent_run", actor: orgAdmin, op: "manage", policy: ownerDefault })).allowed,
    ).toBe(true);
    for (const op of ["list", "read", "use", "execute", "share"] as const) {
      expect(
        evaluateExtensionAccess(base({ kind: "agent_run", actor: orgAdmin, op, policy: ownerDefault })).allowed,
      ).toBe(false);
    }
  });

  it("a plain member gets NO admin standing on any kind (owner-default row stays denied)", () => {
    const member = human("m", { orgRole: "member" });
    for (const kind of ["skill", "connection", "agent_run"] as const) {
      expect(
        evaluateExtensionAccess(base({ kind, actor: member, op: "read", policy: ownerDefault })).allowed,
      ).toBe(false);
    }
  });

  it("a cross-org admin is denied on an owner-default row of another org (guard wins)", () => {
    const crossOrgAdmin = human("oa", { organizationId: OTHER_ORG, orgRole: "org_admin" });
    expect(
      evaluateExtensionAccess(base({ kind: "skill", actor: crossOrgAdmin, op: "read", policy: ownerDefault })),
    ).toEqual({ allowed: false, reason: "cross_org" });
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
