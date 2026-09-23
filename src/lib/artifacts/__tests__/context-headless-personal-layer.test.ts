/**
 * A HEADLESS RUN CARRIES NO PERSONAL CONTEXT LAYER (cinatra#2815 S3, epic
 * #2812).
 *
 * Context resolution builds its actor from `run.runBy`, which is durable
 * OWNERSHIP and not evidence that a person started THIS run: a schedule, a
 * trigger or an orchestrator child all keep a human owner. The ownership filter
 * then admitted that person's PRIVATE artifacts into a run nobody was watching.
 *
 * The run's frozen assignment-scope snapshot is the authority on whether a
 * person started it, exactly as it is for assigned skills. This suite pins that
 * ONLY the user axis moves: the organization, team, project and platform-role
 * axes are what the run legitimately carries and are untouched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const readAgentRunById = vi.fn();
const readAgentRunByTokenHash = vi.fn();
const readAgentTemplateById = vi.fn();

vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunByTokenHash: (...a: unknown[]) => readAgentRunByTokenHash(...a),
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
  readAgentRunByContextId: vi.fn(),
  readAgentTemplateById: (...a: unknown[]) => readAgentTemplateById(...a),
}));
vi.mock("@cinatra-ai/agents/agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: () => "/tmp/does-not-exist",
  resolveDevExtensionSourceRoot: () => "/tmp/does-not-exist-dev-source",
}));
vi.mock("@/lib/wayflow-bridge-auth", () => ({ isAuthorizedBridgeRequest: () => true }));
vi.mock("@/lib/a2a-auth", () => ({ verifyLangGraphBridgeToken: () => ({ ok: true }) }));
vi.mock("@/lib/agent-run-actor-resolve", () => ({
  resolveAgentRunMcpActor: async () => ({ platformRole: "member" }),
}));
vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: async () => [{ id: "team-1" }],
  readProjectGrantsForUser: async () => [{ projectId: "proj-1" }],
}));
vi.mock("@cinatra-ai/mcp-server/obo-ceiling", () => ({
  deriveOboCeilingChain: () => null,
  oboCeilingContains: () => false,
}));
vi.mock("@/lib/authz/build-actor-context", () => ({
  // The real builder's shape, as this seam consumes it.
  buildActorContextFromPrimitive: (
    primitive: { userId: string },
    orgId: string,
    opts: { platformRole: string; teamIds: string[]; projectGrants: unknown[] },
  ) => ({
    principalType: "HumanUser",
    principalId: primitive.userId,
    organizationId: orgId,
    platformRole: opts.platformRole,
    teamIds: opts.teamIds,
    projectIds: ["proj-1"],
  }),
}));
vi.mock("../context-mcp", () => ({ getInstalledExtensionDescriptors: () => [] }));
vi.mock("../context-resolver", () => ({ resolveContextSlot: () => [] }));

const { deriveContextRouteContext } = await import("../context-route-io");

const PKG = "@cinatra-ai/blog-draft-writer-agent";

function request(): Request {
  // Run identity rides the dispatch-minted run token only (#1193).
  return new Request("http://localhost/api/context-resolve", {
    method: "POST",
    headers: { "x-cinatra-run-token": "t" },
  });
}

function body() {
  return { parentRunId: "run-1", parentPackageName: PKG, slotId: "draftContext" };
}

function run(over: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    orgId: "org-1",
    runBy: "owner-1",
    templateId: "tmpl-1",
    projectId: null,
    oboCeiling: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  readAgentTemplateById.mockResolvedValue({ packageName: PKG, ownerLevel: null, ownerId: null });
  readAgentRunByTokenHash.mockResolvedValue({ id: "run-1", orgId: "org-1", runBy: "owner-1" });
});

describe("the personal axis follows the snapshot, not the run's owner", () => {
  it("carries it when the snapshot names the owner as the originating human", async () => {
    readAgentRunById.mockResolvedValue(
      run({
        assignmentScopeSnapshot: {
          v: 1,
          orgId: "org-1",
          teamIds: [],
          originatingHumanUserId: "owner-1",
        },
      }),
    );
    const ctx = await deriveContextRouteContext(request(), body(), "resolve");
    expect(ctx.actor.principalId).toBe("owner-1");
  });

  it("REMOVES it for a headless run whose snapshot names no originating human", async () => {
    readAgentRunById.mockResolvedValue(
      run({ assignmentScopeSnapshot: { v: 1, orgId: "org-1", teamIds: [] } }),
    );
    const ctx = await deriveContextRouteContext(request(), body(), "resolve");
    expect(ctx.actor.principalId).toBeUndefined();
    // Only that axis moves.
    expect(ctx.actor.organizationId).toBe("org-1");
    expect(ctx.actor.teamIds).toEqual(["team-1"]);
    expect(ctx.actor.projectIds).toEqual(["proj-1"]);
    expect(ctx.actor.platformRole).toBe("member");
  });

  it("REMOVES it when the snapshot names a DIFFERENT person than the run's owner", async () => {
    readAgentRunById.mockResolvedValue(
      run({
        assignmentScopeSnapshot: {
          v: 1,
          orgId: "org-1",
          teamIds: [],
          originatingHumanUserId: "someone-else",
        },
      }),
    );
    const ctx = await deriveContextRouteContext(request(), body(), "resolve");
    expect(ctx.actor.principalId).toBeUndefined();
  });

  it("REMOVES it on the sole legacy fallback, which names no originating human", async () => {
    readAgentRunById.mockResolvedValue(run({ assignmentScopeSnapshot: "not a snapshot" }));
    const ctx = await deriveContextRouteContext(request(), body(), "resolve");
    expect(ctx.actor.principalId).toBeUndefined();
    expect(ctx.actor.organizationId).toBe("org-1");
  });
});
