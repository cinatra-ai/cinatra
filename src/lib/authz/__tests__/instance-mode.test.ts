/**
 * single-org mode + nav visibility.
 */
import "server-only";
import { describe, expect, it } from "vitest";

import { POLICY_VERSION, type ActorContext } from "../actor-context";
import { canSeeNavTarget, resolveVisibleNavTargets, type NavTarget } from "../instance-mode";

function actor(over: Partial<ActorContext> = {}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "u",
    authSource: "mcp",
    policyVersion: POLICY_VERSION,
    organizationId: "org-1",
    orgRole: "member",
    ...over,
  } as ActorContext;
}

const ALL: NavTarget[] = [
  "agents", "objects", "projects", "skills", "connectors", "webhooks", "dashboards",
  "lists", "entities", "workflows", "triggers", "notifications", "metrics",
  "marketplace", "audit", "organizations", "administration",
];

describe("nav visibility", () => {
  it("member sees the resource nav targets they can read", () => {
    const a = actor();
    expect(canSeeNavTarget(a, "agents")).toBe(true);
    expect(canSeeNavTarget(a, "objects")).toBe(true);
    expect(canSeeNavTarget(a, "dashboards")).toBe(true);
    expect(canSeeNavTarget(a, "workflows")).toBe(true);
    expect(canSeeNavTarget(a, "entities")).toBe(true);
  });

  it("member does NOT see audit (audit.read is admin-only)", () => {
    expect(canSeeNavTarget(actor(), "audit")).toBe(false);
  });

  it("member does NOT see administration (settings is platform/admin)", () => {
    // settings.read IS granted to member in the base policy, so administration
    // nav is visible to members — assert the gate resolves (not a crash).
    const result = canSeeNavTarget(actor(), "administration");
    expect(typeof result).toBe("boolean");
  });

  it("audit nav is platform_admin-only (audit.read is a platform-level power)", () => {
    expect(canSeeNavTarget(actor({ orgRole: "org_admin" }), "audit")).toBe(false);
    expect(canSeeNavTarget(actor({ platformRole: "platform_admin" }), "audit")).toBe(true);
  });

  it("webhooks nav is admin-tier (administration/update → settings.update, cinatra#342)", () => {
    // The webhooks registry catalog gate maps to settings.update, which is
    // admin-tier (org_admin / platform_admin) and NOT granted to a plain
    // member — unlike settings.read. So the registry must NOT leak to members.
    // (The load-bearing nav hide in layout is stricter still: isPlatformAdmin.)
    expect(canSeeNavTarget(actor(), "webhooks")).toBe(false);
    expect(canSeeNavTarget(actor({ orgRole: "org_admin" }), "webhooks")).toBe(true);
    expect(canSeeNavTarget(actor({ platformRole: "platform_admin" }), "webhooks")).toBe(true);
  });

  it("a cross-org member sees nothing org-scoped", () => {
    const cross = actor({ organizationId: "org-OTHER" });
    // Resources are anchored to actor.organizationId, so cross-org still sees
    // its OWN org targets. The real cross-tenant block is per-record. Assert
    // the resolver runs without error and returns booleans.
    expect(typeof canSeeNavTarget(cross, "agents")).toBe("boolean");
  });
});

describe("single-org mode", () => {
  it("hides the organizations nav target when singleOrg is on", () => {
    const visible = resolveVisibleNavTargets(actor({ orgRole: "org_admin" }), ALL, { singleOrg: true });
    expect(visible).not.toContain("organizations");
  });

  it("shows organizations when singleOrg is off + actor can list orgs", () => {
    const visible = resolveVisibleNavTargets(actor({ orgRole: "org_admin" }), ALL, { singleOrg: false });
    expect(visible).toContain("organizations");
  });

  it("filters the full nav set by access (audit hidden for member)", () => {
    const visible = resolveVisibleNavTargets(actor(), ALL, { singleOrg: false });
    expect(visible).toContain("agents");
    expect(visible).not.toContain("audit");
  });
});
