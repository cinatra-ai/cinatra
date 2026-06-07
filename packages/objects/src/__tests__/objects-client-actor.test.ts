// The session client envelope translation must carry the full actor context
// exactly as the objects handlers read it: `roles` string[] for role hints,
// teamRoles, organizationId+orgId, projectGrants/projectIds for scoped
// access, and userId for actor extension and save-default derivation.
import { describe, it, expect } from "vitest";
import type { ActorContext } from "@/lib/authz/actor-context";
import { actorContextToObjectsEnvelope } from "../objects-actor-envelope";

const POLICY = "v2";

describe("actorContextToObjectsEnvelope", () => {
  it("platform admin → roles includes platform_admin, userId + orgId set", () => {
    const actor: ActorContext = {
      principalType: "HumanUser",
      principalId: "user_1",
      organizationId: "org_1",
      platformRole: "platform_admin",
      orgRole: "org_owner",
      authSource: "ui",
      policyVersion: POLICY,
    };
    const env = actorContextToObjectsEnvelope(actor) as Record<string, unknown>;
    expect(env.actorType).toBe("human");
    expect(env.userId).toBe("user_1");
    expect(env.orgId).toBe("org_1");
    expect(env.organizationId).toBe("org_1");
    expect(env.roles).toContain("platform_admin");
    expect(env.roles).toContain("owner"); // org_owner → "owner"
  });

  it("org admin → roles includes admin", () => {
    const actor: ActorContext = {
      principalType: "HumanUser",
      principalId: "user_2",
      organizationId: "org_1",
      orgRole: "org_admin",
      authSource: "ui",
      policyVersion: POLICY,
    };
    const env = actorContextToObjectsEnvelope(actor) as Record<string, unknown>;
    expect(env.roles).toContain("admin");
    expect(env.roles).not.toContain("platform_admin");
  });

  it("member with project grants + team roles → forwards both", () => {
    const actor: ActorContext = {
      principalType: "HumanUser",
      principalId: "user_3",
      organizationId: "org_1",
      orgRole: "member",
      teamRoles: { team_a: "team_admin" },
      teamIds: ["team_a"],
      projectGrants: [
        { projectId: "proj_1", effectiveRole: "write", accessSource: "user" },
      ],
      projectIds: ["proj_1"],
      authSource: "ui",
      policyVersion: POLICY,
    };
    const env = actorContextToObjectsEnvelope(actor) as Record<string, unknown>;
    expect(env.roles).toEqual(["member"]);
    expect(env.teamRoles).toEqual({ team_a: "team_admin" });
    expect(env.projectGrants).toEqual([
      { projectId: "proj_1", effectiveRole: "write", accessSource: "user" },
    ]);
    expect(env.projectIds).toEqual(["proj_1"]);
  });

  it("role-less System actor → actorType system, no userId, no roles, orgId carried", () => {
    const actor: ActorContext = {
      principalType: "System",
      principalId: "system",
      organizationId: "org_1",
      authSource: "worker",
      policyVersion: POLICY,
    };
    const env = actorContextToObjectsEnvelope(actor) as Record<string, unknown>;
    expect(env.actorType).toBe("system");
    expect(env.userId).toBeUndefined();
    expect(env.orgId).toBe("org_1");
    expect(env.roles).toBeUndefined();
    expect(env.source).toBe("worker");
  });
});
