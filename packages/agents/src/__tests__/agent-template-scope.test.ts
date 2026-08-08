/**
 * cinatra#2485 C — the PURE four-level install-scope evaluator.
 *
 * Locks the owner-ratified rule that makes an agent's install (or later-set)
 * scope THE run-authorization gate:
 *   personal → the owning user; team → actor.teamIds ∋ owner_id;
 *   project  → actor.projectIds / projectGrants ∋ owner_id;
 *   organization → a member of the owning org, with ORG-ADMIN standing
 *   counting at that level; anything else (null / workspace / platform /
 *   corrupt) → DENY.
 *
 * Also locks the two properties that make it purpose-built rather than a reuse
 * of `evaluateExtensionAccess`: there is NO universal platform-admin grant, and
 * `published` is not consulted at all (discovery may be public; invocation is
 * scope-bound).
 */
import { describe, it, expect } from "vitest";
import type { ActorContext } from "@/lib/authz/actor-context";
import {
  AgentTemplateScopeError,
  assertActorWithinAgentTemplateScope,
  evaluateActorWithinAgentTemplateScope,
  normalizeAgentTemplateScopeLevel,
  type AgentTemplateScopeRef,
} from "../auth-policy";

const ORG = "org-alpha";
const OTHER_ORG = "org-beta";

function human(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: ORG,
    teamIds: [],
    projectGrants: [],
    projectIds: [],
    orgRole: "member",
    platformRole: "member",
    authSource: "ui",
    policyVersion: "v2",
    ...overrides,
  } as ActorContext;
}

function template(
  overrides: Partial<AgentTemplateScopeRef> = {},
): AgentTemplateScopeRef {
  return { id: "tmpl-1", orgId: ORG, ownerLevel: null, ownerId: null, ...overrides };
}

describe("normalizeAgentTemplateScopeLevel", () => {
  it("accepts exactly the four authorizing levels", () => {
    for (const level of ["user", "team", "project", "organization"]) {
      expect(normalizeAgentTemplateScopeLevel(level)).toBe(level);
    }
  });

  it("returns null (⇒ DENY) for null, workspace, platform and junk — never coerces to organization", () => {
    for (const level of [null, undefined, "", "workspace", "platform", "wat"]) {
      expect(normalizeAgentTemplateScopeLevel(level)).toBeNull();
    }
  });
});

describe("personal scope (owner_level='user')", () => {
  const tpl = template({ ownerLevel: "user", ownerId: "user-1" });

  it("allows the owning user", () => {
    const d = evaluateActorWithinAgentTemplateScope(tpl, human({ principalId: "user-1" }));
    expect(d).toEqual({ allowed: true, level: "user", via: "owner" });
  });

  it("denies any other user in the same org", () => {
    const d = evaluateActorWithinAgentTemplateScope(tpl, human({ principalId: "user-2" }));
    expect(d).toEqual({ allowed: false, reason: "not_owner", level: "user" });
  });

  it("denies a platform_admin — there is NO universal admin grant", () => {
    const d = evaluateActorWithinAgentTemplateScope(
      tpl,
      human({ principalId: "user-2", platformRole: "platform_admin", orgRole: "org_owner" }),
    );
    expect(d).toEqual({ allowed: false, reason: "not_owner", level: "user" });
  });

  it("denies an org_admin — org-admin standing counts at ORG scope only", () => {
    const d = evaluateActorWithinAgentTemplateScope(
      tpl,
      human({ principalId: "user-2", orgRole: "org_admin" }),
    );
    expect(d).toEqual({ allowed: false, reason: "not_owner", level: "user" });
  });

  it("denies a non-human principal even when it names the owner via runAsUserId", () => {
    const svc = {
      principalType: "ServiceAccount",
      principalId: "svc-1",
      organizationId: ORG,
      runAsUserId: "user-1",
      delegatedBy: "user-1",
      teamIds: [],
      projectIds: [],
      projectGrants: [],
      authSource: "a2a",
      policyVersion: "v2",
    } as unknown as ActorContext;
    expect(evaluateActorWithinAgentTemplateScope(tpl, svc)).toEqual({
      allowed: false,
      reason: "not_owner",
      level: "user",
    });
  });

  it("denies when owner_id is missing (indeterminate scope)", () => {
    const d = evaluateActorWithinAgentTemplateScope(
      template({ ownerLevel: "user", ownerId: null }),
      human(),
    );
    expect(d).toEqual({ allowed: false, reason: "unknown_scope", level: "user" });
  });
});

describe("team scope (owner_level='team')", () => {
  const tpl = template({ ownerLevel: "team", ownerId: "team-7" });

  it("allows a member of the owning team", () => {
    const d = evaluateActorWithinAgentTemplateScope(tpl, human({ teamIds: ["team-3", "team-7"] }));
    expect(d).toEqual({ allowed: true, level: "team", via: "team_member" });
  });

  it("denies an org member who does not hold the owning team", () => {
    const d = evaluateActorWithinAgentTemplateScope(tpl, human({ teamIds: ["team-3"] }));
    expect(d).toEqual({ allowed: false, reason: "not_team_member", level: "team" });
  });

  it("denies when teamIds was never resolved", () => {
    const d = evaluateActorWithinAgentTemplateScope(tpl, human({ teamIds: undefined }));
    expect(d).toEqual({ allowed: false, reason: "not_team_member", level: "team" });
  });
});

describe("project scope (owner_level='project')", () => {
  const tpl = template({ ownerLevel: "project", ownerId: "proj-9" });

  it("allows via the derived projectIds axis", () => {
    const d = evaluateActorWithinAgentTemplateScope(tpl, human({ projectIds: ["proj-9"] }));
    expect(d).toEqual({ allowed: true, level: "project", via: "project_member" });
  });

  it("allows via projectGrants even when the derived projectIds shortcut is empty", () => {
    const d = evaluateActorWithinAgentTemplateScope(
      tpl,
      human({
        projectIds: [],
        projectGrants: [{ projectId: "proj-9", effectiveRole: "read", accessSource: "team" }],
      }),
    );
    expect(d).toEqual({ allowed: true, level: "project", via: "project_member" });
  });

  it("denies an org member with no grant on the owning project", () => {
    const d = evaluateActorWithinAgentTemplateScope(
      tpl,
      human({ projectIds: ["proj-1"], projectGrants: [] }),
    );
    expect(d).toEqual({ allowed: false, reason: "not_project_member", level: "project" });
  });
});

describe("organization scope (owner_level='organization')", () => {
  const tpl = template({ ownerLevel: "organization", ownerId: ORG });

  it("allows any member of the owning org", () => {
    const d = evaluateActorWithinAgentTemplateScope(tpl, human());
    expect(d).toEqual({ allowed: true, level: "organization", via: "org_member" });
  });

  it("allows an org_admin AT ORG SCOPE, recorded as org_admin standing", () => {
    const d = evaluateActorWithinAgentTemplateScope(tpl, human({ orgRole: "org_admin" }));
    expect(d).toEqual({ allowed: true, level: "organization", via: "org_admin" });
  });

  it("allows an org_owner AT ORG SCOPE", () => {
    const d = evaluateActorWithinAgentTemplateScope(tpl, human({ orgRole: "org_owner" }));
    expect(d).toEqual({ allowed: true, level: "organization", via: "org_admin" });
  });

  it("denies an actor from another org (a published org-wide agent is NOT global)", () => {
    const d = evaluateActorWithinAgentTemplateScope(tpl, human({ organizationId: OTHER_ORG }));
    expect(d).toEqual({ allowed: false, reason: "cross_org", level: "organization" });
  });

  it("denies an org-less template whose owner_id names no org", () => {
    const d = evaluateActorWithinAgentTemplateScope(
      template({ orgId: null, ownerLevel: "organization", ownerId: null }),
      human(),
    );
    expect(d).toEqual({ allowed: false, reason: "unknown_scope", level: "organization" });
  });

  it("admits a member of an org-less template's explicitly named owning org", () => {
    const d = evaluateActorWithinAgentTemplateScope(
      template({ orgId: null, ownerLevel: "organization", ownerId: ORG }),
      human(),
    );
    expect(d).toEqual({ allowed: true, level: "organization", via: "org_member" });
  });

  it("denies an org-less template whose owner_id names a DIFFERENT org than the actor", () => {
    const d = evaluateActorWithinAgentTemplateScope(
      template({ orgId: null, ownerLevel: "organization", ownerId: OTHER_ORG }),
      human(),
    );
    expect(d).toEqual({ allowed: false, reason: "not_org_member", level: "organization" });
  });

  it("denies corrupt ownership (org anchor and owner_id disagree)", () => {
    const d = evaluateActorWithinAgentTemplateScope(
      template({ orgId: ORG, ownerLevel: "organization", ownerId: "not-an-org" }),
      human(),
    );
    expect(d).toEqual({ allowed: false, reason: "unknown_scope", level: "organization" });
  });
});

describe("unknown / null scope → DENY", () => {
  it("denies a null owner_level", () => {
    const d = evaluateActorWithinAgentTemplateScope(
      template({ ownerLevel: null, ownerId: null }),
      human({ orgRole: "org_owner" }),
    );
    expect(d).toEqual({ allowed: false, reason: "unknown_scope", level: null });
  });

  it("denies a 'workspace' owner_level rather than widening it to the org", () => {
    const d = evaluateActorWithinAgentTemplateScope(
      template({ ownerLevel: "workspace", ownerId: ORG }),
      human(),
    );
    expect(d).toEqual({ allowed: false, reason: "unknown_scope", level: null });
  });

  it("denies a PLATFORM-fallback shaped row — never cross-org run authority", () => {
    const d = evaluateActorWithinAgentTemplateScope(
      template({ orgId: null, ownerLevel: "platform", ownerId: "__platform__" }),
      human(),
    );
    expect(d).toEqual({ allowed: false, reason: "unknown_scope", level: null });
  });
});

describe("cross-org guard runs before every level rule", () => {
  it("denies a foreign-org actor whose user id matches the personal owner", () => {
    const d = evaluateActorWithinAgentTemplateScope(
      template({ orgId: ORG, ownerLevel: "user", ownerId: "user-1" }),
      human({ principalId: "user-1", organizationId: OTHER_ORG }),
    );
    expect(d).toEqual({ allowed: false, reason: "cross_org", level: "user" });
  });

  it("denies a foreign-org actor carrying the owning team id", () => {
    const d = evaluateActorWithinAgentTemplateScope(
      template({ orgId: ORG, ownerLevel: "team", ownerId: "team-7" }),
      human({ organizationId: OTHER_ORG, teamIds: ["team-7"] }),
    );
    expect(d).toEqual({ allowed: false, reason: "cross_org", level: "team" });
  });

  it("denies an org-less actor on an org-anchored template", () => {
    const d = evaluateActorWithinAgentTemplateScope(
      template({ ownerLevel: "organization", ownerId: ORG }),
      human({ organizationId: undefined }),
    );
    expect(d).toEqual({ allowed: false, reason: "cross_org", level: "organization" });
  });
});

describe("no actor", () => {
  it("denies null and undefined actors (fail closed)", () => {
    const tpl = template({ ownerLevel: "organization", ownerId: ORG });
    expect(evaluateActorWithinAgentTemplateScope(tpl, null)).toEqual({
      allowed: false,
      reason: "no_actor",
      level: null,
    });
    expect(evaluateActorWithinAgentTemplateScope(tpl, undefined)).toEqual({
      allowed: false,
      reason: "no_actor",
      level: null,
    });
  });
});

describe("publication is not authority", () => {
  it("evaluates identically regardless of any status-shaped extra field", () => {
    const base = template({ ownerLevel: "team", ownerId: "team-7" });
    const published = { ...base, status: "published" } as AgentTemplateScopeRef;
    const actor = human({ teamIds: [] });
    expect(evaluateActorWithinAgentTemplateScope(published, actor)).toEqual(
      evaluateActorWithinAgentTemplateScope(base, actor),
    );
  });
});

describe("assertActorWithinAgentTemplateScope", () => {
  it("returns the allowing decision when in scope", () => {
    const decision = assertActorWithinAgentTemplateScope(
      template({ ownerLevel: "organization", ownerId: ORG }),
      human(),
    );
    expect(decision.allowed).toBe(true);
  });

  it("throws a machine-readable AgentTemplateScopeError when out of scope", () => {
    let thrown: unknown;
    try {
      assertActorWithinAgentTemplateScope(
        template({ ownerLevel: "user", ownerId: "user-1" }),
        human({ principalId: "user-2" }),
        { stage: "create" },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AgentTemplateScopeError);
    const err = thrown as AgentTemplateScopeError;
    expect(err.code).toBe("AGENT_TEMPLATE_SCOPE_DENIED");
    expect(err.reason).toBe("not_owner");
    expect(err.level).toBe("user");
    expect(err.templateId).toBe("tmpl-1");
    expect(err.stage).toBe("create");
  });
});
