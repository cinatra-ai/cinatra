/**
 * agent_source_publish RBAC + audit.
 *
 * The publish handler must authorize through the `requireAccess` primitive
 * with the `release_manager` role gate (the central registry classifies
 * `marketplace_template::publish` with `requireRole: "release_manager"`) AND
 * write an `audit_events` row on BOTH success (decision:"allowed") and
 * denial (decision:"denied").
 *
 * Three walls are exercised:
 *   (a) a non-admin / non-release-manager actor is DENIED with a denied audit row.
 *   (b) the authorized release_manager path passes the gate (requireAccess
 *       resolves) and is NOT collapsed to the admin Unauthorized surface,
 *       and the gate emits NO denial for that actor.
 *   (c) the platform_admin superset path bypasses requireAccess (so admins who
 *       lack an explicit release_manager grant are NOT locked out) and writes an
 *       allowed audit row at the gate.
 *
 * `requireAccess` is mocked so the test controls deny/allow deterministically
 * without depending on registry/`can()` resolution; the gate's explicit
 * `logAuditEvent` rows are captured via the mocked `@/lib/authz`.
 *
 * Mock surface mirrors the proven handlers-importing test
 * (agent-source-write-progress.test.ts) so the heavy agents MCP module graph
 * (and its @cinatra-ai/llm → openai-connector chain) loads in the vitest
 * sandbox.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockLogAuditEvent,
  mockRequireAccess,
  mockResolveEffectiveRoleNamesForUser,
  mockPublishFromGitDir,
  FakeAuthzError,
} = vi.hoisted(() => {
  class FakeAuthzError extends Error {
    statusCode = 403;
    reason = "forbidden";
    constructor(args?: { message?: string; reason?: string }) {
      super(args?.message ?? "denied");
      if (args?.reason) this.reason = args.reason;
    }
  }
  return {
    mockLogAuditEvent: vi.fn(async () => undefined),
    mockRequireAccess: vi.fn(async (..._args: unknown[]) => undefined),
    // The standard MCP actor envelope does NOT carry role grants — the handler
    // must RESOLVE effective roles from the role-grant store. Default: no extra
    // roles (so the existing deny/admin cases are unaffected).
    mockResolveEffectiveRoleNamesForUser: vi.fn(async () => [] as string[]),
    mockPublishFromGitDir: vi.fn(async () => ({
      published: true,
      packageName: "@cinatra/test-pkg",
      packageVersion: "1.0.0",
      registryUrl: "http://127.0.0.1:4873",
      alreadyPublished: false,
    })),
    FakeAuthzError,
  };
});

// Fully stub @/lib/authz (like the proven handlers test) so the real authz
// barrel + its auth chain never load. logAuditEvent is the assertable spy.
vi.mock("@/lib/authz", () => ({
  logAuditEvent: mockLogAuditEvent,
  POLICY_VERSION: "1.0",
  AuthzError: FakeAuthzError,
  can: vi.fn(() => false),
}));

// The handler dynamically `await import("@/lib/authz/require-access")`. Control
// the release_manager role gate deterministically.
vi.mock("@/lib/authz/require-access", () => ({
  requireAccess: mockRequireAccess,
}));

// The handler dynamically `await import("@/lib/authz/role-grant-store")` to
// resolve the user's effective role names (org + platform grants) — the MCP
// actor envelope omits them. Control the resolved roles deterministically.
vi.mock("@/lib/authz/role-grant-store", () => ({
  resolveEffectiveRoleNamesForUser: mockResolveEffectiveRoleNamesForUser,
}));

// Short-circuit the heavy llm chain (openai-connector is absent in this worktree).
vi.mock("@cinatra-ai/llm", () => ({
  getActorContext: () => null,
  getActorContextOrThrow: () => { throw new Error("not used"); },
  withActorContext: (_ctx: unknown, fn: () => unknown) => fn(),
  resolveProviderAdapter: () => null,
  ANTHROPIC_API_LOG_DIRECTORY: "/tmp",
  setAnthropicLoggingEnabled: () => {},
}));

vi.mock("@cinatra-ai/notifications/server", () => ({ safeEmitAgentCreationProgress: vi.fn() }));
vi.mock("@cinatra-ai/skills", () => ({
  upsertSkill: vi.fn(),
  parseFrontmatter: vi.fn(),
  readLocalPackageSkillContent: vi.fn(),
}));
vi.mock("@cinatra-ai/registries", () => ({ listAgentPackages: vi.fn() }));
vi.mock("@cinatra-ai/objects", () => ({ createDeterministicObjectsClient: vi.fn(() => ({})) }));
vi.mock("@cinatra-ai/mcp-client", () => ({
  invokePrimitive: vi.fn(),
  createInProcessPrimitiveTransport: vi.fn(),
  PrimitiveInvocationError: class extends Error {},
}));

vi.mock("../compiler", () => ({ compileWorkflow: vi.fn() }));
vi.mock("../wayflow-url", () => ({ resolveWayflowUrl: vi.fn() }));
vi.mock("../verdaccio/client", () => ({
  deleteAgentPackageVersion: vi.fn(),
  deprecateAgentPackageVersion: vi.fn(),
  publishAgentPackage: vi.fn(),
  publishAgentPackageFromGitDir: mockPublishFromGitDir,
}));
vi.mock("../verdaccio/publish-metadata", () => ({ derivePublishMetadataFromSnapshot: vi.fn() }));
vi.mock("../install-from-package", () => ({ installAgentFromPackage: vi.fn(async () => undefined) }));
vi.mock("../review-task-actions", () => ({ approveReviewTaskInternal: vi.fn() }));
vi.mock("../trigger-service", () => ({
  setRunTriggerForActor: vi.fn(),
  getRunTriggerForActor: vi.fn(),
  deleteRunTriggerForActor: vi.fn(),
}));
vi.mock("../agent-install-path", () => ({ resolveAgentInstallDir: vi.fn(() => process.cwd()) }));
vi.mock("../zip-helpers", () => ({ createZipBuffer: vi.fn() }));
vi.mock("../oas-compiler", () => ({ compileOasAgentJson: vi.fn((p: unknown) => p) }));
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(async () => undefined),
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "agent_builder_execution" },
}));
vi.mock("@/lib/primitive-handlers", () => ({ collectAllPrimitiveHandlers: vi.fn(() => ({})) }));
vi.mock("@/lib/mcp-pagination", () => ({
  decodeCursor: vi.fn(() => 0),
  buildListPage: vi.fn(() => ({ items: [], nextCursor: null })),
}));
vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: vi.fn(async () => []),
  readProjectsForUser: vi.fn(async () => []),
  readProjectGrantsForUser: vi.fn(async () => []),
  readUserById: vi.fn(async () => null),
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => null),
  isPlatformAdmin: vi.fn(() => false),
  requireAuthSession: vi.fn(),
}));
vi.mock("../auth-policy", () => ({ enforceRunAccess: vi.fn(async () => undefined) }));
vi.mock("../store", () => ({ resolveDefaultOrgId: vi.fn(async () => "org-1") }));
vi.mock("@/lib/dev-extensions", () => ({ readEffectivePublishScopeOverride: vi.fn(() => null) }));
vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(() => ({ instanceNamespace: "cinatra-ai" })),
  markFirstPublishedIfCurrentScope: vi.fn(),
}));

import { createAgentBuilderPrimitiveHandlers } from "../mcp/handlers";

type Handler = (req: {
  primitiveName: string;
  input: Record<string, unknown>;
  actor: Record<string, unknown>;
  mode: string;
}) => Promise<unknown>;

const handlers = createAgentBuilderPrimitiveHandlers() as Record<string, Handler>;

function publishReq(actor: Record<string, unknown>, input: Record<string, unknown> = {}) {
  return {
    primitiveName: "agent_source_publish",
    input: { packageSlug: "test-pkg", ...input },
    actor: { actorType: "human", source: "ui", ...actor },
    mode: "deterministic",
  };
}

function auditRows(): Record<string, unknown>[] {
  return (mockLogAuditEvent.mock.calls as unknown as unknown[][]).map(
    (c) => c[0] as Record<string, unknown>,
  );
}

describe("agent_source_publish — publish RBAC + audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish default impls cleared by clearAllMocks.
    mockLogAuditEvent.mockResolvedValue(undefined);
    mockResolveEffectiveRoleNamesForUser.mockResolvedValue([]);
    mockPublishFromGitDir.mockResolvedValue({
      published: true,
      packageName: "@cinatra/test-pkg",
      packageVersion: "1.0.0",
      registryUrl: "http://127.0.0.1:4873",
      alreadyPublished: false,
    });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("(a) denies a non-admin / non-release-manager actor AND writes a denied audit row", async () => {
    // Real registry denies a roleless actor; simulate that by throwing.
    mockRequireAccess.mockRejectedValueOnce(
      new FakeAuthzError({ reason: "forbidden", message: "release_manager required" }),
    );

    const result = (await handlers.agent_source_publish(
      publishReq({ userId: "u-nonpriv", orgId: "org-1" }),
    )) as { error?: string };

    expect(result.error).toMatch(/Unauthorized.*admin session required/i);
    // requireAccess was the gate that ran for the non-admin actor.
    expect(mockRequireAccess).toHaveBeenCalledTimes(1);

    const denied = auditRows().filter(
      (r) =>
        r.decision === "denied" &&
        r.resourceType === "marketplace_template" &&
        r.operation === "publish",
    );
    expect(denied.length).toBeGreaterThanOrEqual(1);
    expect(denied[0].resourceId).toBe("test-pkg");
    expect(denied[0].actorPrincipalId).toBe("u-nonpriv");
  });

  it("(b) authorizes a release_manager actor (requireAccess passes) and does NOT return the admin Unauthorized surface", async () => {
    mockRequireAccess.mockResolvedValueOnce(undefined);

    const result = (await handlers.agent_source_publish(
      publishReq({ userId: "u-rm", orgId: "org-1", roles: ["release_manager"] }),
    )) as { error?: string };

    if (result.error) {
      expect(result.error).not.toMatch(/Unauthorized.*admin session required/i);
    }
    // The release_manager role gate ran via requireAccess.
    expect(mockRequireAccess).toHaveBeenCalledTimes(1);
    // The resource ref passed to requireAccess was the marketplace_template
    // publish action for this package.
    const [, resourceRef, action] = mockRequireAccess.mock.calls[0] as unknown[];
    expect((resourceRef as { resourceType?: string }).resourceType).toBe("marketplace_template");
    expect((resourceRef as { resourceId?: string }).resourceId).toBe("test-pkg");
    expect(action).toBe("publish");

    // No denial was emitted at the gate for the authorized actor.
    const denied = auditRows().filter(
      (r) => r.decision === "denied" && r.resourceType === "marketplace_template",
    );
    expect(denied.length).toBe(0);
  });

  it("(d) RESOLVES effective roles for an actor whose envelope carries NO roles — merges the release_manager grant before the gate and passes it", async () => {
    // The standard MCP actor envelope does NOT carry role grants. An actor with
    // userId + orgId but NO roles in the envelope must still authorize as a
    // release_manager IF the role-grant store resolves that role for them. Were
    // the handler to read ONLY the (empty) envelope roles, the synth actor handed
    // to requireAccess would carry roles:[] and a real release_manager would be
    // wrongly denied.
    mockResolveEffectiveRoleNamesForUser.mockResolvedValueOnce(["release_manager"]);
    // requireAccess here delegates to the real registry's release_manager gate
    // shape: allow ONLY when the resolved actor actually holds release_manager.
    mockRequireAccess.mockImplementationOnce(async (...args: unknown[]) => {
      const actor = args[0] as { roles?: string[] } | undefined;
      if (!actor?.roles?.includes("release_manager")) {
        throw new FakeAuthzError({ reason: "forbidden", message: "release_manager required" });
      }
      return undefined;
    });

    const result = (await handlers.agent_source_publish(
      // No `roles` key in the envelope — only userId + orgId (the standard shape).
      publishReq({ userId: "u-resolved-rm", orgId: "org-1" }),
    )) as { error?: string };

    // The store was consulted to resolve the actor's effective roles.
    expect(mockResolveEffectiveRoleNamesForUser).toHaveBeenCalledWith("u-resolved-rm", "org-1");
    // The gate ran and was handed the RESOLVED-and-merged role set.
    expect(mockRequireAccess).toHaveBeenCalledTimes(1);
    const [synthActor] = mockRequireAccess.mock.calls[0] as unknown[];
    expect((synthActor as { roles?: string[] }).roles).toContain("release_manager");

    // The publish passed the gate — NOT collapsed to the admin Unauthorized surface.
    if (result.error) {
      expect(result.error).not.toMatch(/Unauthorized.*admin session required/i);
    }
    // No denial was emitted for the (resolved) release_manager actor.
    const denied = auditRows().filter(
      (r) => r.decision === "denied" && r.resourceType === "marketplace_template",
    );
    expect(denied.length).toBe(0);
  });

  it("(c) admin superset path bypasses requireAccess and writes an allowed audit row", async () => {
    const result = (await handlers.agent_source_publish(
      publishReq({ userId: "u-admin", orgId: "org-1", platformRole: "platform_admin" }),
    )) as { error?: string };

    // Admin must NOT be locked out.
    if (result.error) {
      expect(result.error).not.toMatch(/Unauthorized.*admin session required/i);
    }
    // Admin path skips requireAccess (avoids release_manager-only lockout).
    expect(mockRequireAccess).not.toHaveBeenCalled();

    const allowed = auditRows().filter(
      (r) =>
        r.decision === "allowed" &&
        r.resourceType === "marketplace_template" &&
        r.operation === "publish" &&
        (r.metadata as { via?: string } | undefined)?.via === "platform_admin",
    );
    expect(allowed.length).toBe(1);
    expect(allowed[0].resourceId).toBe("test-pkg");
    expect(allowed[0].actorPrincipalId).toBe("u-admin");
  });
});
