import { describe, it, expect } from "vitest";
import {
  EFFECTIVE_GRANTS,
  POLICY_VERSION,
  type ActorContext,
} from "@/lib/authz";
import {
  FIXT_ADMIN,
  FIXT_MEMBER_A,
  FIXT_SERVICE_ACCOUNT,
  ORG_A,
  RES_AGENT_ORG_A,
  RES_AGENT_ORG_B,
  expectPermission,
} from "./fixtures";

describe("authz kernel — smoke matrix", () => {
  it("platform_admin can read across orgs", () => {
    expectPermission(FIXT_ADMIN, "agent.read", RES_AGENT_ORG_B, true);
  });

  it("org member can execute agents within their org", () => {
    expectPermission(FIXT_MEMBER_A, "agent.execute", RES_AGENT_ORG_A, true);
  });

  it("org member is denied cross-org access", () => {
    expectPermission(FIXT_MEMBER_A, "agent.read", RES_AGENT_ORG_B, false);
  });
});

describe("authz kernel — policy table invariants", () => {
  it("EFFECTIVE_GRANTS is non-empty for every role and member ⊂ org_admin ⊂ org_owner", () => {
    expect(EFFECTIVE_GRANTS.platform_admin.length, "platform_admin grants").toBeGreaterThan(0);
    expect(EFFECTIVE_GRANTS.org_owner.length, "org_owner grants").toBeGreaterThan(0);
    expect(EFFECTIVE_GRANTS.org_admin.length, "org_admin grants").toBeGreaterThan(0);
    expect(EFFECTIVE_GRANTS.team_admin.length, "team_admin grants").toBeGreaterThan(0);
    expect(EFFECTIVE_GRANTS.member.length, "member grants").toBeGreaterThan(0);
    expect(EFFECTIVE_GRANTS.service_account.length, "service_account grants").toBeGreaterThan(0);
    expect(EFFECTIVE_GRANTS.external_agent.length, "external_agent grants").toBeGreaterThan(0);

    // member ⊂ org_admin
    for (const perm of EFFECTIVE_GRANTS.member) {
      expect(
        EFFECTIVE_GRANTS.org_admin.includes(perm),
        `org_admin missing inherited member permission "${perm}"`,
      ).toBe(true);
    }

    // org_admin ⊂ org_owner
    for (const perm of EFFECTIVE_GRANTS.org_admin) {
      expect(
        EFFECTIVE_GRANTS.org_owner.includes(perm),
        `org_owner missing inherited org_admin permission "${perm}"`,
      ).toBe(true);
    }

    // member ⊂ team_admin (locked-in inheritance edge from policies.ts).
    // Guards against a regression that drops the
    // INHERITS.team_admin = ["member"] edge.
    for (const perm of EFFECTIVE_GRANTS.member) {
      expect(
        EFFECTIVE_GRANTS.team_admin.includes(perm),
        `team_admin missing inherited member permission "${perm}"`,
      ).toBe(true);
    }
  });
});

describe("authz kernel — tenant isolation (service accounts)", () => {
  it("service account in org A cannot execute agents in org B", () => {
    expectPermission(FIXT_SERVICE_ACCOUNT, "agent.execute", RES_AGENT_ORG_B, false);
  });

  it("service account with no org cannot execute agents in any org", () => {
    const actor: ActorContext = { ...FIXT_SERVICE_ACCOUNT, organizationId: undefined };
    expectPermission(actor, "agent.execute", RES_AGENT_ORG_A, false);
    expectPermission(actor, "agent.execute", RES_AGENT_ORG_B, false);
  });

  it("service account in org A can execute agents in org A", () => {
    expectPermission(FIXT_SERVICE_ACCOUNT, "agent.execute", RES_AGENT_ORG_A, true);
  });

  it("org member with no active org cannot read agents in any org", () => {
    const actor: ActorContext = { ...FIXT_MEMBER_A, organizationId: undefined };
    expectPermission(actor, "agent.read", RES_AGENT_ORG_A, false);
    expectPermission(actor, "agent.read", RES_AGENT_ORG_B, false);
  });
});

// Locks in the explicit-contract decision that InternalWorker callers MUST
// provide platformRole/orgRole/teamRoles.
describe("authz kernel — internal worker contract", () => {
  it("InternalWorker with no platformRole is denied agent.execute", () => {
    const actor: ActorContext = {
      principalType: "InternalWorker",
      principalId: "worker-1",
      organizationId: ORG_A,
      authSource: "worker",
      policyVersion: POLICY_VERSION,
    };
    expectPermission(actor, "agent.execute", RES_AGENT_ORG_A, false);
  });

  it("InternalWorker with platformRole platform_admin can read across orgs", () => {
    const actor: ActorContext = {
      principalType: "InternalWorker",
      principalId: "worker-1",
      organizationId: ORG_A,
      platformRole: "platform_admin",
      authSource: "worker",
      policyVersion: POLICY_VERSION,
    };
    expectPermission(actor, "agent.read", RES_AGENT_ORG_B, true);
  });
});

// Synthetic roles do NOT inherit member.
describe("authz kernel — synthetic role isolation", () => {
  it("service_account does NOT inherit member.run.list", () => {
    expect(EFFECTIVE_GRANTS.service_account.includes("run.list")).toBe(false);
  });

  it("external_agent does NOT inherit member.object.create", () => {
    expect(EFFECTIVE_GRANTS.external_agent.includes("object.create")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Registry mutation permissions are granted to org_admin.
// Locks in the policy-table edit and locks out silent inheritance to member.
// ---------------------------------------------------------------------------

describe("authz kernel — registry mutation grants", () => {
  it("org_admin has registry.install", () => {
    expect(EFFECTIVE_GRANTS.org_admin.includes("registry.install")).toBe(true);
  });

  it("org_admin has registry.update", () => {
    expect(EFFECTIVE_GRANTS.org_admin.includes("registry.update")).toBe(true);
  });

  it("org_admin has registry.uninstall", () => {
    expect(EFFECTIVE_GRANTS.org_admin.includes("registry.uninstall")).toBe(true);
  });

  it("member does NOT have any registry mutation perm (defense against accidental inheritance)", () => {
    expect(EFFECTIVE_GRANTS.member.includes("registry.install")).toBe(false);
    expect(EFFECTIVE_GRANTS.member.includes("registry.update")).toBe(false);
    expect(EFFECTIVE_GRANTS.member.includes("registry.uninstall")).toBe(false);
  });

  it("platform_admin retains all three registry mutation perms (regression)", () => {
    expect(EFFECTIVE_GRANTS.platform_admin.includes("registry.install")).toBe(true);
    expect(EFFECTIVE_GRANTS.platform_admin.includes("registry.update")).toBe(true);
    expect(EFFECTIVE_GRANTS.platform_admin.includes("registry.uninstall")).toBe(true);
  });

  // Explicit assertion that org_owner inherits the new registry mutation grants
  // from org_admin via INHERITS.org_owner = ["org_admin"].
  // The "member ⊂ org_admin ⊂ org_owner" invariant test above only catches the
  // org_admin → org_owner edge for permissions that ALSO live in member's grant
  // set. Since member has no registry mutation perms, a regression that drops
  // the org_admin parent edge would be silent for these new permissions
  // without this dedicated check.
  it("org_owner inherits registry.install from org_admin", () => {
    expect(EFFECTIVE_GRANTS.org_owner.includes("registry.install")).toBe(true);
  });

  it("org_owner inherits registry.update from org_admin", () => {
    expect(EFFECTIVE_GRANTS.org_owner.includes("registry.update")).toBe(true);
  });

  it("org_owner inherits registry.uninstall from org_admin", () => {
    expect(EFFECTIVE_GRANTS.org_owner.includes("registry.uninstall")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// team_admin gains registry.install ONLY.
// Locks both the new positive grant AND the negative invariants:
//   - team_admin does NOT silently get registry.update / .uninstall
//   - member STILL does NOT get registry.install via INHERITS leak
// ---------------------------------------------------------------------------

describe("authz kernel — team_admin registry.install grant", () => {
  it("team_admin has registry.install", () => {
    expect(EFFECTIVE_GRANTS.team_admin.includes("registry.install")).toBe(true);
  });
  it("team_admin does NOT have registry.update", () => {
    expect(EFFECTIVE_GRANTS.team_admin.includes("registry.update")).toBe(false);
  });
  it("team_admin does NOT have registry.uninstall", () => {
    expect(EFFECTIVE_GRANTS.team_admin.includes("registry.uninstall")).toBe(false);
  });
  it("member STILL does NOT have registry.install (one-way INHERITS contract)", () => {
    expect(EFFECTIVE_GRANTS.member.includes("registry.install")).toBe(false);
  });
});
