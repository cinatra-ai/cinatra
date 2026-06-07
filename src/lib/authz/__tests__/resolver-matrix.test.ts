/**
 * Parameterized resolver-level coverage matrix.
 *
 * Per the highest-risk decomposition mitigation:
 * the registry coverage checks catch missing classification but only generated
 * tests catch a buggy resolver. This matrix asserts, for every applicable
 * `(resourceType × action × actorType)` tuple, that the kernel decision matches
 * the policy AND that the tuple has at least one ALLOW and one DENY across the
 * actor profiles.
 *
 * Design (hybrid):
 *   - Exhaustive arm: iterate CLASSIFICATION_ENTRIES × actor profiles, derive
 *     the expected decision from EFFECTIVE_GRANTS + the requireRole gate, and
 *     assert the kernel agrees. Change-sensitive (a registry/grant change that
 *     desyncs surfaces here).
 *   - Independent arm: a hardcoded spot-check table of security-critical
 *     invariants, expressed WITHOUT reference to EFFECTIVE_GRANTS, so the
 *     matrix is not purely self-referential.
 */
import "server-only";
import { describe, expect, it } from "vitest";

import { CLASSIFICATION_ENTRIES, type ClassificationEntry } from "../registry";
import { EFFECTIVE_GRANTS, type Role } from "../policies";
import { POLICY_VERSION, type ActorContext } from "../actor-context";
import { can } from "../enforce";
import type { ResourceRef } from "../resource-ref";

// ---------------------------------------------------------------------------
// Actor profiles — the `actorType` axis of the matrix.
// ---------------------------------------------------------------------------
type Profile = {
  name: string;
  actor: ActorContext;
  /** Roles this actor effectively holds in-org (for the expected-decision derivation). */
  roles: Role[];
};

const ORG = "org-1";

function profile(name: string, over: Partial<ActorContext>, roles: Role[]): Profile {
  return {
    name,
    roles,
    actor: {
      principalType: "HumanUser",
      principalId: `${name}-user`,
      authSource: "mcp",
      policyVersion: POLICY_VERSION,
      organizationId: ORG,
      ...over,
    } as ActorContext,
  };
}

const PROFILES: Profile[] = [
  profile("platform_admin", { platformRole: "platform_admin" }, ["platform_admin"]),
  profile("org_owner", { orgRole: "org_owner" }, ["org_owner", "org_admin", "member"]),
  profile("org_admin", { orgRole: "org_admin" }, ["org_admin", "member"]),
  profile("member", { orgRole: "member" }, ["member"]),
  profile("release_manager", { orgRole: "member", ...({ roles: ["release_manager"] } as Partial<ActorContext>) }, ["member", "release_manager"]),
  profile("developer", { orgRole: "member", ...({ roles: ["developer"] } as Partial<ActorContext>) }, ["member", "developer"]),
  profile("customer", { orgRole: "member", ...({ roles: ["customer"] } as Partial<ActorContext>) }, ["member", "customer"]),
  // cross-org member: same role bag but a DIFFERENT org → cross-tenant guard denies.
  profile("cross_org_member", { organizationId: "org-OTHER", orgRole: "member" }, ["member"]),
  // anonymous: org-less, roleless.
  { name: "anonymous", roles: [], actor: { principalType: "HumanUser", principalId: "anon", authSource: "mcp", policyVersion: POLICY_VERSION } as ActorContext },
];

function orgResource(entry: ClassificationEntry): ResourceRef {
  return {
    resourceType: entry.resourceType,
    resourceId: `${entry.resourceType}-1`,
    organizationId: ORG,
    ownerType: "organization",
    ownerId: ORG,
  };
}

/** Derive the expected decision from the grant table + role gate + cross-org guard. */
function expectedDecision(entry: ClassificationEntry, p: Profile): boolean {
  // Cross-org guard: an org-scoped resource is denied to a different-org actor
  // unless platform_admin.
  const sameOrg = p.actor.organizationId === ORG;
  const isPlatformAdmin = p.roles.includes("platform_admin");
  if (!sameOrg && !isPlatformAdmin) return false;
  if (!sameOrg && isPlatformAdmin) {
    // platform_admin would pass cross-org, but our profile keeps it same-org.
  }
  // Role gate.
  if (entry.requiredAccess.requireRole && !p.roles.includes(entry.requiredAccess.requireRole)) {
    return false;
  }
  // Permission via union of the profile's role grants.
  for (const r of p.roles) {
    if ((EFFECTIVE_GRANTS[r] as readonly string[]).includes(entry.requiredAccess.requiredPermission)) {
      return true;
    }
  }
  return false;
}

describe("resolver matrix — exhaustive arm", () => {
  it("kernel decision matches the derived expectation for every (resourceType×action×actorType)", () => {
    const mismatches: string[] = [];
    for (const entry of CLASSIFICATION_ENTRIES) {
      const resource = orgResource(entry);
      for (const p of PROFILES) {
        const expected = expectedDecision(entry, p);
        // The kernel's can() handles the permission + cross-org guard. The
        // requireRole gate lives in requireAccess; we replicate it here with
        // the profile's role bag so the matrix exercises the full decision.
        const roleGateOk = !entry.requiredAccess.requireRole || p.roles.includes(entry.requiredAccess.requireRole);
        const actual = roleGateOk && can(p.actor, entry.requiredAccess.requiredPermission, resource);
        if (actual !== expected) {
          mismatches.push(`${entry.resourceType}::${entry.action} × ${p.name} — expected ${expected}, got ${actual}`);
        }
      }
    }
    if (mismatches.length > 0) {
      throw new Error(`Resolver matrix mismatches (${mismatches.length}):\n` + mismatches.slice(0, 40).join("\n"));
    }
    expect(mismatches).toEqual([]);
  });

  it("every tuple has at least one ALLOW and one DENY across the profile set", () => {
    // N/A allowlist: tuples that cannot legitimately have both an allow and a
    // deny among the profiles. Each carries a justification. (Empty today —
    // every tuple has an allow via owner/admin and a deny via anonymous.)
    const NA: Record<string, string> = {};

    const noAllow: string[] = [];
    const noDeny: string[] = [];
    for (const entry of CLASSIFICATION_ENTRIES) {
      const key = `${entry.resourceType}::${entry.action}`;
      if (NA[key]) continue;
      const resource = orgResource(entry);
      let anyAllow = false;
      let anyDeny = false;
      for (const p of PROFILES) {
        const roleGateOk = !entry.requiredAccess.requireRole || p.roles.includes(entry.requiredAccess.requireRole);
        const actual = roleGateOk && can(p.actor, entry.requiredAccess.requiredPermission, resource);
        if (actual) anyAllow = true;
        else anyDeny = true;
      }
      if (!anyAllow) noAllow.push(key);
      if (!anyDeny) noDeny.push(key);
    }
    if (noAllow.length > 0 || noDeny.length > 0) {
      throw new Error(
        `Tuples lacking allow/deny coverage (add to NA allowlist with justification if intentional):\n` +
          (noAllow.length ? `  no ALLOW: ${noAllow.join(", ")}\n` : "") +
          (noDeny.length ? `  no DENY: ${noDeny.join(", ")}` : ""),
      );
    }
    expect({ noAllow, noDeny }).toEqual({ noAllow: [], noDeny: [] });
  });
});

// ---------------------------------------------------------------------------
// Independent arm — hardcoded security-critical invariants. Expressed WITHOUT
// reference to EFFECTIVE_GRANTS so the matrix is not purely self-referential.
// ---------------------------------------------------------------------------
describe("resolver matrix — security spot-checks", () => {
  const member = PROFILES.find((p) => p.name === "member")!.actor;
  const crossOrg = PROFILES.find((p) => p.name === "cross_org_member")!.actor;
  const anon = PROFILES.find((p) => p.name === "anonymous")!.actor;
  const orgAdmin = PROFILES.find((p) => p.name === "org_admin")!.actor;
  const res = (rt: ResourceRef["resourceType"]): ResourceRef => ({
    resourceType: rt, resourceId: `${rt}-1`, organizationId: ORG, ownerType: "organization", ownerId: ORG,
  });

  it("cross-tenant member is denied a same-permission read in another org", () => {
    expect(can(crossOrg, "object.read", res("object"))).toBe(false);
  });

  it("anonymous is denied every read", () => {
    expect(can(anon, "object.read", res("object"))).toBe(false);
    expect(can(anon, "agent.read", res("agent"))).toBe(false);
    expect(can(anon, "dashboard.read", res("dashboard"))).toBe(false);
  });

  it("member cannot delete objects or agents (admin-only)", () => {
    expect(can(member, "object.delete", res("object"))).toBe(false);
    expect(can(member, "agent.delete", res("agent"))).toBe(false);
  });

  it("customer role grants no write power", () => {
    const customer = PROFILES.find((p) => p.name === "customer")!.actor;
    expect(can(customer, "object.update", res("object"))).toBe(false);
    expect(can(customer, "agent.update", res("agent"))).toBe(false);
    expect(can(customer, "object.delete", res("object"))).toBe(false);
  });

  it("only release_manager holds marketplace_template.publish (member/admin do not)", () => {
    const rm = PROFILES.find((p) => p.name === "release_manager")!.actor;
    expect(can(rm, "marketplace_template.publish", res("marketplace_template"))).toBe(true);
    expect(can(member, "marketplace_template.publish", res("marketplace_template"))).toBe(false);
    expect(can(orgAdmin, "marketplace_template.publish", res("marketplace_template"))).toBe(false);
  });

  it("developer can edit agent source but cannot delete agents", () => {
    const dev = PROFILES.find((p) => p.name === "developer")!.actor;
    expect(can(dev, "agent.update", res("agent"))).toBe(true);
    expect(can(dev, "agent.delete", res("agent"))).toBe(false);
  });

  it("org_admin can delete within its org but not cross-tenant", () => {
    expect(can(orgAdmin, "object.delete", res("object"))).toBe(true);
    const crossAdmin = { ...orgAdmin, organizationId: "org-OTHER" } as ActorContext;
    expect(can(crossAdmin, "object.delete", res("object"))).toBe(false);
  });
});
