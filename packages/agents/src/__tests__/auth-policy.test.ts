// Tests for the AgentAuthPolicy framework.
// Groups A-G cover policy shape, actor mapping, run access, connector access, and HITL mapping.
//
// Note on mocking can(): we spy on the named export from the @/lib/authz
// barrel. The barrel re-exports `can` from ./enforce.ts, and our auth-policy.ts
// imports `can` directly from "@/lib/authz", so vi.spyOn(authz, "can")
// intercepts the same module reference both modules see.

import { describe, it, expect, vi, beforeEach } from "vitest";

import * as authz from "@/lib/authz";
import type { Permission } from "@/lib/authz";

import {
  DEFAULT_AGENT_AUTH_POLICY,
  AgentAuthPolicySchema,
  OPERATION_PERMISSION,
  buildActorContextFromPrimitive,
  enforceRunAccess,
  checkConnectorAccess,
} from "../auth-policy";
import type { RunAccessOperation } from "../auth-policy";

// ---------------------------------------------------------------------------
// Group A: Type + DEFAULT shape
// ---------------------------------------------------------------------------

describe("DEFAULT_AGENT_AUTH_POLICY", () => {
  it("A1: deep-equals the locked default (all visibility=owner, allowRunSharing=false, no description)", () => {
    expect(DEFAULT_AGENT_AUTH_POLICY).toEqual({
      // Multi-scope W1: visibility fields are non-empty token arrays.
      runListVisibility: ["owner"],
      runDataVisibility: ["owner"],
      runExecuteVisibility: ["owner"],
      allowRunSharing: false,
    });
    expect(Object.prototype.hasOwnProperty.call(DEFAULT_AGENT_AUTH_POLICY, "description")).toBe(false);
  });

  it("A2: is Object.freeze'd (mutating throws in strict mode)", () => {
    expect(Object.isFrozen(DEFAULT_AGENT_AUTH_POLICY)).toBe(true);
    expect(() => {
      // Frozen-object mutation under strict mode (which test files run in
      // by default with ESM) throws TypeError. The cast strips the readonly
      // signal so TS doesn't error on the deliberate write — the runtime
      // throw is what we're verifying.
      (DEFAULT_AGENT_AUTH_POLICY as { allowRunSharing: boolean }).allowRunSharing = true;
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Group B: AgentAuthPolicySchema (zod)
// ---------------------------------------------------------------------------

describe("AgentAuthPolicySchema", () => {
  it("B1: parses a valid object (stored scalars coerce to arrays)", () => {
    const input = {
      runListVisibility: "owner",
      runDataVisibility: "org",
      runExecuteVisibility: "admin",
      allowRunSharing: true,
    };
    expect(AgentAuthPolicySchema.parse(input)).toEqual({
      runListVisibility: ["owner"],
      runDataVisibility: ["org"],
      runExecuteVisibility: ["admin"],
      allowRunSharing: true,
    });
  });

  it("B2: preserves an optional description (scalars coerce to arrays)", () => {
    const input = {
      runListVisibility: "owner",
      runDataVisibility: "org",
      runExecuteVisibility: "admin",
      allowRunSharing: true,
      description: "x",
    };
    expect(AgentAuthPolicySchema.parse(input)).toEqual({
      runListVisibility: ["owner"],
      runDataVisibility: ["org"],
      runExecuteVisibility: ["admin"],
      allowRunSharing: true,
      description: "x",
    });
  });

  it("B3: rejects a disallowed visibility value", () => {
    expect(() =>
      AgentAuthPolicySchema.parse({
        runListVisibility: "everyone",
        runDataVisibility: "org",
        runExecuteVisibility: "admin",
        allowRunSharing: true,
      }),
    ).toThrow();
  });

  it("B4: requires allowRunSharing", () => {
    expect(() =>
      AgentAuthPolicySchema.parse({
        runListVisibility: "owner",
        runDataVisibility: "owner",
        runExecuteVisibility: "owner",
      }),
    ).toThrow();
  });

  it("B5: rejects allowRunSharing as a string", () => {
    expect(() =>
      AgentAuthPolicySchema.parse({
        runListVisibility: "owner",
        runDataVisibility: "owner",
        runExecuteVisibility: "owner",
        allowRunSharing: "true",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Group C: buildActorContextFromPrimitive() actor mapping
// ---------------------------------------------------------------------------

describe("buildActorContextFromPrimitive", () => {
  it("C1: actorType=human + userId='u1' → HumanUser/principalId='u1'/authSource='ui'", () => {
    const ctx = buildActorContextFromPrimitive({
      actorType: "human",
      userId: "u1",
      source: "ui",
    });
    expect(ctx.principalType).toBe("HumanUser");
    expect(ctx.principalId).toBe("u1");
    expect(ctx.authSource).toBe("ui");
  });

  it("C2: actorType=model + userId='svc-llm-1' → ServiceAccount/'svc-llm-1'/authSource='mcp'", () => {
    const ctx = buildActorContextFromPrimitive({
      actorType: "model",
      userId: "svc-llm-1",
      source: "agent",
    });
    expect(ctx.principalType).toBe("ServiceAccount");
    expect(ctx.principalId).toBe("svc-llm-1");
    expect(ctx.authSource).toBe("mcp");
  });

  it("C3: actorType=system + userId undefined → InternalWorker / fallback principalId / authSource='worker'", () => {
    const ctx = buildActorContextFromPrimitive({
      actorType: "system",
      source: "worker",
    });
    expect(ctx.principalType).toBe("InternalWorker");
    expect(ctx.principalId).toBe("system");
    expect(ctx.authSource).toBe("worker");
  });

  it("C4: actorType=a2a + userId='ext-agent-7' → ExternalA2AAgent/'ext-agent-7'/authSource='a2a'", () => {
    const ctx = buildActorContextFromPrimitive({
      actorType: "a2a",
      userId: "ext-agent-7",
      source: "route",
    });
    expect(ctx.principalType).toBe("ExternalA2AAgent");
    expect(ctx.principalId).toBe("ext-agent-7");
    expect(ctx.authSource).toBe("a2a");
  });

  it("C5: returned context always has policyVersion=POLICY_VERSION", () => {
    const ctx = buildActorContextFromPrimitive({
      actorType: "human",
      userId: "u1",
      source: "ui",
    });
    expect(ctx.policyVersion).toBe(authz.POLICY_VERSION);
  });

  it("C6: runOrgId arg maps to organizationId on the returned context", () => {
    const ctx = buildActorContextFromPrimitive(
      { actorType: "human", userId: "u1", source: "ui" },
      "org-xyz",
    );
    expect(ctx.organizationId).toBe("org-xyz");
  });
});

// ---------------------------------------------------------------------------
// Group D: enforceRunAccess() — happy path
// ---------------------------------------------------------------------------

describe("enforceRunAccess (happy path)", () => {
  beforeEach(() => vi.restoreAllMocks());

  // enforceRunAccess short-circuits with an owner grant when
  // actor.actorType === "human", actor.userId === run.runBy. The happy-path
  // tests below intentionally use a non-owner actor (userId "u2" against
  // runBy "u1") so the kernel-routing behavior — operation→permission map,
  // ResourceRef shape — is still exercised through the can() spy. The owner
  // short-circuit is covered by the dedicated "owner short-circuit" tests
  // further below.
  it("D1: resolves when can() returns true (read op)", async () => {
    vi.spyOn(authz, "can").mockReturnValue(true);
    await expect(
      enforceRunAccess(
        { id: "r1", runBy: "u1", orgId: "o1" },
        { actorType: "human", userId: "u2", source: "ui" },
        "read",
      ),
    ).resolves.toBeUndefined();
  });

  it("D2: maps op='list'→'run.list', op='read'→'run.read', op='execute'→'run.resume'", async () => {
    const spy = vi.spyOn(authz, "can").mockReturnValue(true);
    await enforceRunAccess(
      { id: "r1", runBy: "u1", orgId: "o1" },
      { actorType: "human", userId: "u2", source: "ui" },
      "list",
    );
    expect(spy).toHaveBeenLastCalledWith(expect.anything(), "run.list", expect.anything());

    await enforceRunAccess(
      { id: "r1", runBy: "u1", orgId: "o1" },
      { actorType: "human", userId: "u2", source: "ui" },
      "read",
    );
    expect(spy).toHaveBeenLastCalledWith(expect.anything(), "run.read", expect.anything());

    await enforceRunAccess(
      { id: "r1", runBy: "u1", orgId: "o1" },
      { actorType: "human", userId: "u2", source: "ui" },
      "execute",
    );
    expect(spy).toHaveBeenLastCalledWith(expect.anything(), "run.resume", expect.anything());
  });

  it("D3: builds a ResourceRef with resourceType='run', resourceId, ownerType='user', ownerId, organizationId", async () => {
    const spy = vi.spyOn(authz, "can").mockReturnValue(true);
    await enforceRunAccess(
      { id: "r1", runBy: "u1", orgId: "o1" },
      { actorType: "human", userId: "u2", source: "ui" },
      "read",
    );
    const resourceArg = spy.mock.calls[0]?.[2];
    expect(resourceArg).toMatchObject({
      resourceType: "run",
      resourceId: "r1",
      ownerType: "user",
      ownerId: "u1",
      organizationId: "o1",
    });
  });

  // Owner short-circuit: when actor is the run owner, allow
  // without consulting can(). This guards against the kernel's missing
  // "actor owns this user-owned resource" branch and matches the
  // default policy of owner-only access.
  it("D4: owner short-circuit allows the run owner without calling can()", async () => {
    const spy = vi.spyOn(authz, "can").mockReturnValue(false);
    await expect(
      enforceRunAccess(
        { id: "r1", runBy: "u1", orgId: "o1" },
        { actorType: "human", userId: "u1", source: "ui" },
        "read",
      ),
    ).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Group E: enforceRunAccess() — denial path
// ---------------------------------------------------------------------------

describe("enforceRunAccess (denial path)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("E1: throws AuthzError 404 hidden when can() returns false on a *.read op", async () => {
    // Read denials are downgraded to
    // 404 hidden so probing callers cannot distinguish 403 (exists, denied)
    // from 404 (does not exist) — prevents resource-id enumeration.
    // Mutating ops still return 403; the parallel coverage is in
    // auth-policy-token-scope.test.ts.
    vi.spyOn(authz, "can").mockReturnValue(false);
    await expect(
      enforceRunAccess(
        { id: "r1", runBy: "u1", orgId: "o1" },
        { actorType: "human", userId: "u2", source: "ui" },
        "read",
      ),
    ).rejects.toMatchObject({ statusCode: 404, reason: "hidden" });
  });

  it("E2: throws AuthzError 403 when actor is null", async () => {
    await expect(
      enforceRunAccess(
        { id: "r1", runBy: "u1", orgId: "o1" },
        null,
        "read",
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("E2b: throws AuthzError 403 when actor is undefined", async () => {
    await expect(
      enforceRunAccess(
        { id: "r1", runBy: "u1", orgId: "o1" },
        undefined,
        "read",
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("E3: throws AuthzError 404 hidden when run is null", async () => {
    await expect(
      enforceRunAccess(
        null,
        { actorType: "human", userId: "u1", source: "ui" },
        "read",
      ),
    ).rejects.toMatchObject({ statusCode: 404, reason: "hidden" });
  });

  it("E3b: throws AuthzError 404 hidden when run is undefined", async () => {
    await expect(
      enforceRunAccess(
        undefined,
        { actorType: "human", userId: "u1", source: "ui" },
        "read",
      ),
    ).rejects.toMatchObject({ statusCode: 404, reason: "hidden" });
  });
});

// ---------------------------------------------------------------------------
// Group F: checkConnectorAccess() — fail-closed authority
// ---------------------------------------------------------------------------
// Connector access is fail-CLOSED: an unknown / unauthorized connector throws AuthzError.

describe("checkConnectorAccess (fail-closed)", () => {
  it("throws AuthzError for an unknown connector (fail-closed)", async () => {
    await expect(
      checkConnectorAccess("any-connector-id", {
        actorType: "human",
        userId: "u",
        source: "route",
      }),
    ).rejects.toMatchObject({ name: "AuthzError", statusCode: 403 });
  });
});

// ---------------------------------------------------------------------------
// Group G: HITL operation mapping
// ---------------------------------------------------------------------------

describe("HITL operation mapping", () => {
  beforeEach(() => vi.restoreAllMocks());

  it.each([
    ["approveHitl", "run.approveHitl"],
    ["respondToHitl", "run.respondToHitl"],
    ["editOutput", "run.editOutput"],
  ] as const)("maps op=%s to Permission=%s", async (op, perm) => {
    const spy = vi.spyOn(authz, "can").mockReturnValue(true);
    // Use a non-owner actor so the kernel can() spy is consulted
    // (the owner short-circuit returns void without calling can()).
    await enforceRunAccess(
      { id: "r1", runBy: "u1", orgId: "o1" },
      { actorType: "human", userId: "u2", source: "ui" },
      op,
    );
    expect(spy).toHaveBeenCalledWith(expect.anything(), perm, expect.anything());
  });

  it("G4: throws AuthzError 403 on op='approveHitl' when can() returns false", async () => {
    vi.spyOn(authz, "can").mockReturnValue(false);
    await expect(
      enforceRunAccess(
        { id: "r1", runBy: "u1", orgId: "o1" },
        { actorType: "human", userId: "u2", source: "ui" },
        "approveHitl",
      ),
    ).rejects.toMatchObject({ statusCode: 403, reason: "forbidden" });
  });

  it("G5: OPERATION_PERMISSION exhaustively covers RunAccessOperation (compile-time guard)", () => {
    // If RunAccessOperation gains a new variant without a corresponding
    // OPERATION_PERMISSION entry, this function fails to typecheck (`never`
    // assignment error in the default branch). The runtime assertion below
    // only spot-checks one entry — the typecheck is the load-bearing test.
    function assertOperationCovered(op: RunAccessOperation): Permission {
      switch (op) {
        case "list":
          return OPERATION_PERMISSION.list;
        case "read":
          return OPERATION_PERMISSION.read;
        case "execute":
          return OPERATION_PERMISSION.execute;
        case "approveHitl":
          return OPERATION_PERMISSION.approveHitl;
        case "respondToHitl":
          return OPERATION_PERMISSION.respondToHitl;
        case "editOutput":
          return OPERATION_PERMISSION.editOutput;
        // cancel + share are RunAccessOperation variants —
        // adding them here keeps the exhaustive `never` guard load-bearing.
        case "cancel":
          return OPERATION_PERMISSION.cancel;
        case "share":
          return OPERATION_PERMISSION.share;
        default: {
          const _exhaustive: never = op;
          throw new Error(`Unhandled RunAccessOperation: ${String(_exhaustive)}`);
        }
      }
    }
    expect(assertOperationCovered("approveHitl")).toBe("run.approveHitl");
    expect(assertOperationCovered("cancel")).toBe("run.cancel");
    expect(assertOperationCovered("share")).toBe("run.share");
  });
});

// ---------------------------------------------------------------------------
// Group H: Admin override end-to-end (no can() mock)
//
// These tests exercise the real kernel and real policyAllows by passing
// `{ platformRole: "platform_admin" }` and asserting admins are granted
// regardless of policy or ownership. Role forwarding and the admin bypass
// must both work for this group to pass.
// ---------------------------------------------------------------------------

describe("enforceRunAccess (admin override, no can() mock)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("H1: platform admin reads non-owned run via real kernel + policy gate", async () => {
    // No can() mock — real kernel is consulted. The actor is NOT the owner
    // (userId="admin-1" vs runBy="u1"), so the owner short-circuit does not
    // fire. When the roles parameter forwards platform_admin into
    // actorContext.platformRole, the kernel grants run.read.
    await expect(
      enforceRunAccess(
        { id: "r1", runBy: "u1", orgId: "o1" },
        { actorType: "human", userId: "admin-1", source: "ui" },
        "read",
        { platformRole: "platform_admin" },
      ),
    ).resolves.toBeUndefined();
  });

  it("H2: platform admin allowed against runDataVisibility='owner' policy", async () => {
    // No can() mock. The effective policy locks runDataVisibility to "owner"
    // — the locked default. The admin bypass returns true uniformly across
    // all tiers.
    await expect(
      enforceRunAccess(
        {
          id: "r1",
          runBy: "u1",
          orgId: "o1",
          effectivePolicy: {
            runListVisibility: ["owner"],
            runDataVisibility: ["owner"],
            runExecuteVisibility: ["owner"],
            allowRunSharing: false,
          },
        },
        { actorType: "human", userId: "admin-1", source: "ui" },
        "read",
        { platformRole: "platform_admin" },
      ),
    ).resolves.toBeUndefined();
  });

  it("H3: non-admin non-owner denied against runDataVisibility='owner' policy", async () => {
    // Counter-test for H2: without admin role, the same call must be denied
    // by the policy gate (the kernel cross-org guard does not fire because
    // resource.organizationId is set and matches in this case, but the
    // policy gate explicitly rejects "owner" tier for non-owners).
    //
    // Note: a non-admin non-owner whose actor is human + source="ui" will
    // be denied by `can()` long before policyAllows runs (the kernel has
    // no role grant for this actor against a user-owned resource). What
    // this test really proves is that without admin role hint, the bypass
    // is NOT applied and the call rejects.
    await expect(
      enforceRunAccess(
        {
          id: "r1",
          runBy: "u1",
          orgId: "o1",
          effectivePolicy: {
            runListVisibility: ["owner"],
            runDataVisibility: ["owner"],
            runExecuteVisibility: ["owner"],
            allowRunSharing: false,
          },
        },
        { actorType: "human", userId: "u2", source: "ui" },
        "read",
        { platformRole: "member" },
      ),
    ).rejects.toThrow();
  });

  it("H4: platform admin denied 'execute' tier — kernel does not grant run.resume to platform_admin", async () => {
    // Kernel policy: platform_admin gets read/list grants
    // (audit/read-everything power) but NOT execute-tier grants — admins
    // can inspect every run but cannot resume/stop runs they don't own
    // unless they're also a member of the run's org. This test locks that
    // boundary so the policy-gate admin-bypass does NOT silently
    // overpower the kernel's deliberately-narrow grant set.
    //
    // If admins SHOULD be able to execute non-owned
    // runs, the fix is to add run.resume / run.approveHitl / run.editOutput
    // to platform_admin's DIRECT_GRANTS in src/lib/authz/policies.ts —
    // NOT to widen policyAllows beyond admin-bypass. Update this test
    // to .resolves.toBeUndefined() at that point.
    await expect(
      enforceRunAccess(
        { id: "r1", runBy: "u1", orgId: "o1" },
        { actorType: "human", userId: "admin-1", source: "ui" },
        "execute",
        { platformRole: "platform_admin" },
      ),
    ).rejects.toThrow();
  });

  it("H5: platform admin lists non-owned runs", async () => {
    // The list path uses runListVisibility; same admin-bypass applies.
    // The list-level probe must allow owners, and admin role hints must reach
    // the kernel so admins can see non-owned rows.
    await expect(
      enforceRunAccess(
        {
          id: "r1",
          runBy: "u1",
          orgId: "o1",
          effectivePolicy: {
            runListVisibility: ["owner"],
            runDataVisibility: ["owner"],
            runExecuteVisibility: ["owner"],
            allowRunSharing: false,
          },
        },
        { actorType: "human", userId: "admin-1", source: "ui" },
        "list",
        { platformRole: "platform_admin" },
      ),
    ).resolves.toBeUndefined();
  });

  it("H6: admin role hint absent → admins-without-roles still denied", async () => {
    // If a future refactor accidentally drops the `roles` parameter from a
    // handler, this test catches the regression: same actor as H1, same
    // call, but no role hint — the kernel cannot grant platform_admin and
    // the call is denied (no can() mock).
    await expect(
      enforceRunAccess(
        { id: "r1", runBy: "u1", orgId: "o1" },
        { actorType: "human", userId: "admin-1", source: "ui" },
        "read",
        // roles intentionally omitted
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Kernel branch tests for the widened `policyAllows()` actor signature and
// the co-owner branch of `enforceRunAccess`. These cover team, project,
// workspace, and co-owner access paths.
// ---------------------------------------------------------------------------
import { policyAllows } from "../auth-policy";
import type { AgentAuthPolicy, AgentAuthPolicyVisibility } from "../auth-policy-types";
import type { ActorContext } from "@/lib/authz/actor-context";

const TEAM_A = "team-a";
const TEAM_B = "team-b";
const PROJECT_X = "project-x";
const PROJECT_Y = "project-y";

function buildActor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: "org-1",
    teamIds: [],
    projectIds: [],
    platformRole: "member",
    orgRole: "member",
    authSource: "ui",
    policyVersion: "v2",
    ...overrides,
  } as ActorContext;
}

function policyOf(v: AgentAuthPolicyVisibility): AgentAuthPolicy {
  return {
    runListVisibility: [v],
    runDataVisibility: [v],
    runExecuteVisibility: [v],
    allowRunSharing: false,
  };
}

describe("policyAllows — widened actor-scope branches", () => {
  describe("team:<id>", () => {
    it("grants when actor.teamIds includes the team id", () => {
      const allowed = policyAllows(
        policyOf(`team:${TEAM_A}` as AgentAuthPolicyVisibility),
        "read",
        buildActor({ teamIds: [TEAM_A] }),
      );
      expect(allowed).toBe(true);
    });

    it("denies when actor.teamIds does not include the team id", () => {
      const allowed = policyAllows(
        policyOf(`team:${TEAM_A}` as AgentAuthPolicyVisibility),
        "read",
        buildActor({ teamIds: [TEAM_B] }),
      );
      expect(allowed).toBe(false);
    });

    it("denies when actor.teamIds is undefined", () => {
      const allowed = policyAllows(
        policyOf(`team:${TEAM_A}` as AgentAuthPolicyVisibility),
        "read",
        buildActor({ teamIds: undefined }),
      );
      expect(allowed).toBe(false);
    });
  });

  describe("project:<id>", () => {
    it("grants when actor.projectIds includes the project id", () => {
      const allowed = policyAllows(
        policyOf(`project:${PROJECT_X}` as AgentAuthPolicyVisibility),
        "read",
        buildActor({ projectIds: [PROJECT_X] }),
      );
      expect(allowed).toBe(true);
    });

    it("denies when actor.projectIds does not include the project id", () => {
      const allowed = policyAllows(
        policyOf(`project:${PROJECT_X}` as AgentAuthPolicyVisibility),
        "read",
        buildActor({ projectIds: [PROJECT_Y] }),
      );
      expect(allowed).toBe(false);
    });
  });

  describe("workspace (every workspace user; manage stays admin)", () => {
    it("grants for platformRole platform_admin", () => {
      const allowed = policyAllows(
        policyOf("workspace" as AgentAuthPolicyVisibility),
        "read",
        buildActor({ platformRole: "platform_admin" }),
      );
      expect(allowed).toBe(true);
    });

    it("grants for orgRole org_admin", () => {
      const allowed = policyAllows(
        policyOf("workspace" as AgentAuthPolicyVisibility),
        "read",
        buildActor({ orgRole: "org_admin" }),
      );
      expect(allowed).toBe(true);
    });

    it("grants for orgRole org_owner", () => {
      const allowed = policyAllows(
        policyOf("workspace" as AgentAuthPolicyVisibility),
        "read",
        buildActor({ orgRole: "org_owner" }),
      );
      expect(allowed).toBe(true);
    });

    // "Workspace: All" means every workspace user can use the resource.
    // policyAllows runs after the kernel can()/enforceRunAccess cross-org and
    // missing-actor guards, so a plain member here is a legitimate same-org
    // user and is allowed.
    it("grants for plain member (workspace = every workspace user)", () => {
      const allowed = policyAllows(
        policyOf("workspace" as AgentAuthPolicyVisibility),
        "read",
        buildActor(),
      );
      expect(allowed).toBe(true);
    });
  });

  describe("legacy branches preserved", () => {
    it("\"owner\" denies non-owner non-admin", () => {
      const allowed = policyAllows(
        policyOf("owner"),
        "read",
        buildActor(),
      );
      expect(allowed).toBe(false);
    });

    it("\"org\" allows any org member", () => {
      const allowed = policyAllows(
        policyOf("org"),
        "read",
        buildActor(),
      );
      expect(allowed).toBe(true);
    });

    it("\"admin\" denies non-admin (only platformRole platform_admin bypasses)", () => {
      const allowed = policyAllows(
        policyOf("admin"),
        "read",
        buildActor(),
      );
      expect(allowed).toBe(false);
    });
  });
});

describe("enforceRunAccess — co-owner branch", () => {
  // The co-owner branch consults run.coOwnerUserIds on RunForAccessCheck.
  // When the actor's userId is in the list, ops in the co-owner
  // permission set (list / read / execute / approveHitl / respondToHitl) are
  // granted before the kernel can() check fires. Share / cancel / editOutput
  // are NEVER granted via this branch — those stay owner+admin only.
  beforeEach(() => vi.restoreAllMocks());

  const RUN_OWNER = "user-owner";
  const COOWNER = "user-coowner";
  const STRANGER = "user-stranger";
  const RUN_ID = "run-coowner-1";
  const ORG_ID = "org-1";

  it("grants run.read | run.readData | run.resume | run.approveHitl to a co-owner", async () => {
    // can() will return false (default kernel decision for non-owner against
    // a user-owned resource) — the co-owner short-circuit must fire BEFORE
    // can() is consulted, so the test still succeeds.
    const canSpy = vi.spyOn(authz, "can").mockReturnValue(false);

    const run = {
      id: RUN_ID,
      runBy: RUN_OWNER,
      orgId: ORG_ID,
      coOwnerUserIds: [COOWNER],
      // Restrictive policy: owner-only across the board. Without the co-owner
      // branch, every read attempt would deny — co-owner branch must override.
      effectivePolicy: {
        runListVisibility: ["owner"],
        runDataVisibility: ["owner"],
        runExecuteVisibility: ["owner"],
        allowRunSharing: true,
      } satisfies AgentAuthPolicy,
    };

    const actor = {
      actorType: "human" as const,
      userId: COOWNER,
      source: "ui" as const,
    };

    for (const op of [
      "list",
      "read",
      "execute",
      "approveHitl",
      "respondToHitl",
    ] as RunAccessOperation[]) {
      await expect(enforceRunAccess(run, actor, op)).resolves.toBeUndefined();
    }
    // can() must NOT have been consulted on the read-tier ops above — the
    // co-owner branch fired first.
    expect(canSpy).not.toHaveBeenCalled();
  });

  it("grants run.share | run.cancel | run.editOutput to a co-owner (full co-owner rights)", async () => {
    // COOWNER_OPS gives co-owners full equal rights to the original owner.
    // share, cancel, and editOutput are in the co-owner set. can() is mocked
    // false to confirm the co-owner branch fires before the kernel and grants
    // access regardless of the kernel decision.
    const canSpy = vi.spyOn(authz, "can").mockReturnValue(false);

    const run = {
      id: RUN_ID,
      runBy: RUN_OWNER,
      orgId: ORG_ID,
      coOwnerUserIds: [COOWNER],
      effectivePolicy: {
        runListVisibility: ["owner"],
        runDataVisibility: ["owner"],
        runExecuteVisibility: ["owner"],
        allowRunSharing: true,
      } satisfies AgentAuthPolicy,
    };

    const actor = {
      actorType: "human" as const,
      userId: COOWNER,
      source: "ui" as const,
    };

    // share, cancel, editOutput are all in COOWNER_OPS — the co-owner
    // branch fires before the kernel and grants access.
    await expect(enforceRunAccess(run, actor, "share")).resolves.toBeUndefined();
    await expect(enforceRunAccess(run, actor, "cancel")).resolves.toBeUndefined();
    await expect(enforceRunAccess(run, actor, "editOutput")).resolves.toBeUndefined();
    // The co-owner branch must have fired before can() was consulted.
    expect(canSpy).not.toHaveBeenCalled();
  });

  it("does not grant a stranger anything via the co-owner branch", async () => {
    vi.spyOn(authz, "can").mockReturnValue(false);

    const run = {
      id: RUN_ID,
      runBy: RUN_OWNER,
      orgId: ORG_ID,
      coOwnerUserIds: [COOWNER],
      effectivePolicy: {
        runListVisibility: ["owner"],
        runDataVisibility: ["owner"],
        runExecuteVisibility: ["owner"],
        allowRunSharing: true,
      } satisfies AgentAuthPolicy,
    };

    const actor = {
      actorType: "human" as const,
      userId: STRANGER,
      source: "ui" as const,
    };

    await expect(enforceRunAccess(run, actor, "read")).rejects.toThrow();
  });

  it("does not fire when coOwnerUserIds is undefined (back-compat default)", async () => {
    const canSpy = vi.spyOn(authz, "can").mockReturnValue(false);

    const run = {
      id: RUN_ID,
      runBy: RUN_OWNER,
      orgId: ORG_ID,
      // coOwnerUserIds intentionally omitted — legacy callers that haven't
      // been updated yet must still see the same enforcement behavior
      // (i.e. kernel decides via can()).
      effectivePolicy: {
        runListVisibility: ["owner"],
        runDataVisibility: ["owner"],
        runExecuteVisibility: ["owner"],
        allowRunSharing: false,
      } satisfies AgentAuthPolicy,
    };

    const actor = {
      actorType: "human" as const,
      userId: "anyone-not-the-owner",
      source: "ui" as const,
    };

    await expect(enforceRunAccess(run, actor, "read")).rejects.toThrow();
    expect(canSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Group I: non-human owner short-circuit
//
// When an MCP OAuth "model" or "a2a" actor creates a run, the run stores
// runBy = actor.userId. Subsequent detail calls must succeed for the same
// actor. The human-only guard in the owner short-circuit was blocking them.
// ---------------------------------------------------------------------------
describe("enforceRunAccess — non-human actor owner short-circuit (mcp-run-access-denied fix)", () => {
  it("I1: model actor whose userId matches run.runBy is allowed to read the run (was denied before fix)", async () => {
    // This test currently FAILS (RED) because the owner short-circuit in
    // enforceRunAccess is gated by `actor.actorType === "human"`.
    // After the fix it will pass (GREEN).
    //
    // Scenario: MCP OAuth client creates a run via agent_run
    // (runBy = "svc-client-1"), then calls agent_run_get.
    // Default "owner" policy must NOT deny the creating actor.
    await expect(
      enforceRunAccess(
        {
          id: "r-mcp-1",
          runBy: "svc-client-1",
          orgId: "org-1",
          effectivePolicy: {
            runListVisibility: ["owner"],
            runDataVisibility: ["owner"],
            runExecuteVisibility: ["owner"],
            allowRunSharing: false,
          },
        },
        { actorType: "model", userId: "svc-client-1", source: "mcp" },
        "read",
      ),
    ).resolves.toBeUndefined();
  });

  it("I2: a2a actor whose userId matches run.runBy is allowed to read the run", async () => {
    await expect(
      enforceRunAccess(
        {
          id: "r-a2a-1",
          runBy: "ext-agent-42",
          orgId: "org-1",
          effectivePolicy: {
            runListVisibility: ["owner"],
            runDataVisibility: ["owner"],
            runExecuteVisibility: ["owner"],
            allowRunSharing: false,
          },
        },
        { actorType: "a2a", userId: "ext-agent-42", source: "a2a" },
        "read",
      ),
    ).resolves.toBeUndefined();
  });

  it("I3: model actor whose userId does NOT match run.runBy is denied (policy still enforced)", async () => {
    // A different model actor must NOT inherit the owner grant.
    await expect(
      enforceRunAccess(
        {
          id: "r-mcp-2",
          runBy: "svc-client-1",
          orgId: "org-1",
          effectivePolicy: {
            runListVisibility: ["owner"],
            runDataVisibility: ["owner"],
            runExecuteVisibility: ["owner"],
            allowRunSharing: false,
          },
        },
        { actorType: "model", userId: "svc-client-2", source: "mcp" },
        "read",
      ),
    ).rejects.toThrow();
  });

  it("I4: model actor owner is allowed to execute (approveHitl / resume) their own run", async () => {
    // The model actor that started the run must be able to call
    // agent_run_resume on a pending_approval run.
    await expect(
      enforceRunAccess(
        {
          id: "r-mcp-3",
          runBy: "svc-client-1",
          orgId: "org-1",
          effectivePolicy: {
            runListVisibility: ["owner"],
            runDataVisibility: ["owner"],
            runExecuteVisibility: ["owner"],
            allowRunSharing: false,
          },
        },
        { actorType: "model", userId: "svc-client-1", source: "mcp" },
        "execute",
      ),
    ).resolves.toBeUndefined();
  });
});
