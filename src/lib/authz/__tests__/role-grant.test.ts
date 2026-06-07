/**
 * role_grant store unit tests.
 *
 * Covers: schema shape, kernel integration (developer / release_manager /
 * customer roles flow through to can() via the actor.roles[] axis in
 * resolveRoles).
 *
 * DB-side CRUD is exercised by the integration suite (db-required); this
 * file pins the type-level surface and the kernel propagation.
 */
import "server-only";
import { describe, expect, it } from "vitest";

import { POLICY_VERSION, type ActorContext } from "../actor-context";
import { can } from "../enforce";
import { ALL_ROLES, EFFECTIVE_GRANTS } from "../policies";

describe("role grant roles", () => {
  it("ALL_ROLES contains developer, release_manager, and customer roles", () => {
    expect(ALL_ROLES).toContain("developer");
    expect(ALL_ROLES).toContain("release_manager");
    expect(ALL_ROLES).toContain("customer");
  });

  it("developer role grants agent.update + skill.install", () => {
    const grants = EFFECTIVE_GRANTS.developer;
    expect((grants as readonly string[]).includes("agent.update")).toBe(true);
    expect((grants as readonly string[]).includes("skill.install")).toBe(true);
    expect((grants as readonly string[]).includes("agent.delete")).toBe(false); // developer is not admin
    expect((grants as readonly string[]).includes("project.delete")).toBe(false);
  });

  it("release_manager role grants marketplace_template.publish + workflow_extension.publish", () => {
    const grants = EFFECTIVE_GRANTS.release_manager;
    expect((grants as readonly string[]).includes("marketplace_template.publish")).toBe(true);
    expect((grants as readonly string[]).includes("workflow_extension.publish")).toBe(true);
    // Release manager is a single-capability role; it does not inherit member.
    expect((grants as readonly string[]).includes("agent.update")).toBe(false);
    expect((grants as readonly string[]).includes("project.create")).toBe(false);
  });

  it("customer role grants narrow read + HITL respond + notifications", () => {
    const grants = EFFECTIVE_GRANTS.customer;
    expect((grants as readonly string[]).includes("agent.read")).toBe(true);
    expect((grants as readonly string[]).includes("run.read")).toBe(true);
    expect((grants as readonly string[]).includes("run.respondToHitl")).toBe(true);
    expect((grants as readonly string[]).includes("notification.update")).toBe(true);
    // Customer never gets write/delete authority.
    expect((grants as readonly string[]).includes("agent.update")).toBe(false);
    expect((grants as readonly string[]).includes("agent.delete")).toBe(false);
    expect((grants as readonly string[]).includes("project.create")).toBe(false);
  });

  it("can() admits developer role via actor.roles[]", () => {
    const actor = {
      principalType: "HumanUser",
      principalId: "user-1",
      authSource: "mcp",
      policyVersion: POLICY_VERSION,
      organizationId: "org-1",
      orgRole: "member",
      // Per-scope role granted via role_grant; surfaces here through the
      // session-to-actor bridge in projects/registry.ts.
      roles: ["developer"],
    } as unknown as ActorContext;
    const resource = {
      resourceType: "agent" as const,
      resourceId: "agent-1",
      organizationId: "org-1",
      ownerType: "organization" as const,
      ownerId: "org-1",
    };
    expect(can(actor, "agent.update", resource)).toBe(true);
    expect(can(actor, "agent.delete", resource)).toBe(false); // not granted to developer
  });

  it("can() admits release_manager only for the publish capability", () => {
    const actor = {
      principalType: "HumanUser",
      principalId: "user-2",
      authSource: "mcp",
      policyVersion: POLICY_VERSION,
      organizationId: "org-1",
      orgRole: "member",
      roles: ["release_manager"],
    } as unknown as ActorContext;
    const mt = {
      resourceType: "marketplace_template" as const,
      resourceId: "mt-1",
      organizationId: "org-1",
      ownerType: "organization" as const,
      ownerId: "org-1",
    };
    expect(can(actor, "marketplace_template.publish", mt)).toBe(true);
    // release_manager does not grant project-write via its own DIRECT_GRANTS
    // (member-tier rights are sourced separately from `orgRole: "member"`).
    expect(can(actor, "project.delete", { ...mt, resourceType: "project", resourceId: "p1" })).toBe(false);
  });

  it("can() denies cross-org actors even with the right role", () => {
    const actor = {
      principalType: "HumanUser",
      principalId: "user-3",
      authSource: "mcp",
      policyVersion: POLICY_VERSION,
      organizationId: "org-other",
      orgRole: "member",
      roles: ["release_manager"],
    } as unknown as ActorContext;
    const mt = {
      resourceType: "marketplace_template" as const,
      resourceId: "mt-1",
      organizationId: "org-1",
      ownerType: "organization" as const,
      ownerId: "org-1",
    };
    expect(can(actor, "marketplace_template.publish", mt)).toBe(false);
  });

  it("ignores unknown role names in actor.roles (no privilege escalation)", () => {
    const actor = {
      principalType: "HumanUser",
      principalId: "user-4",
      authSource: "mcp",
      policyVersion: POLICY_VERSION,
      organizationId: "org-1",
      orgRole: "member",
      roles: ["super_admin", "root", "ghost_role"],
    } as unknown as ActorContext;
    const resource = {
      resourceType: "agent" as const,
      resourceId: "agent-1",
      organizationId: "org-1",
      ownerType: "organization" as const,
      ownerId: "org-1",
    };
    expect(can(actor, "agent.delete", resource)).toBe(false);
  });
});
