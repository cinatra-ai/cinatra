/**
 * cinatra#4313: the passthrough stamps the run owner's org role and the run's
 * OBO ceiling on the primitive actor.
 *
 * The publish agent's write_address step merges the page address onto the
 * post artifact through objects_update. That handler asks the resource kernel
 * for object.update on the artifact row, and a run's output row can be owned
 * by the organization. The kernel grants object.update on an
 * organization-owned row to an org admin or an org owner, not to an actor
 * that carries no org role. The passthrough stamped no org role, so an org
 * owner's own run was refused (an AuthzError, answered 500).
 *
 * The role is stamped only when it was read from a real membership row of the
 * run's org: no row (a departed owner) and a lookup error stamp none. The
 * run's OBO ceiling rides with it, as the MCP transport stamps both, so the
 * kernel confines the role to the agent's anchored scope.
 *
 * Drives the real route; the run store, the bridge auth, the run binding, the
 * actor builder, the membership read and the primitive handlers are test
 * doubles. The kernel cases put the actor the handler receives through the
 * real resource kernel.
 *
 *   pnpm exec vitest run src/app/api/agents/passthrough/__tests__/passthrough-run-org-role-4313.test.ts
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  objectsUpdate: vi.fn(),
  resolveRunOwnerMembershipOrgRole: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunById: h.readAgentRunById,
  publishCallAllowed: async () => true, // cinatra#4150: no publish decision holds this run
}));
vi.mock("@/lib/primitive-handlers", () => ({
  collectAllPrimitiveHandlers: async () => ({ objects_update: h.objectsUpdate }),
}));
vi.mock("@/lib/wayflow-bridge-auth", () => ({ isAuthorizedBridgeRequest: () => true }));
vi.mock("@/lib/authz/bridge-run-binding", () => ({
  bindBridgeRunId: async () => ({ ok: true, runId: "run-4313" }),
}));
vi.mock("@/lib/authz/build-actor-context-from-run", () => ({
  // The builder floors a missing membership at `member`; the route must not
  // take its role from here.
  buildActorContextFromRun: vi.fn(async () => ({
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: "org-1",
    platformRole: "member",
    orgRole: "member",
  })),
  resolveRunOwnerMembershipOrgRole: h.resolveRunOwnerMembershipOrgRole,
}));
vi.mock("@cinatra-ai/llm/actor-context", () => ({
  withActorContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

import { POST } from "@/app/api/agents/passthrough/route";
import { enforceResourceAccess } from "@/lib/authz/enforce-resource-access";

const RUN = { id: "run-4313", orgId: "org-1", runBy: "user-1", oboCeiling: null as unknown };

// The organization-owned artifact row the publish run writes back onto.
const ORG_OWNED_ARTIFACT = {
  resourceType: "object" as const,
  resourceId: "artifact-1",
  organizationId: "org-1",
  ownerLevel: "organization" as const,
  ownerId: "org-1",
  visibility: "organization" as const,
  projectId: null,
};

function writeAddressRequest() {
  return new Request("http://localhost:3000/api/agents/passthrough", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cinatra-a2a-context-id": "ctx-4313" },
    body: JSON.stringify({
      tool: "objects_update",
      input: {
        objectId: "artifact-1",
        data: JSON.stringify({
          wordpressPublishedUrl: "https://blog.example.com/?page_id=9",
          wordpressPublishedExternalId: "9",
          wordpressPublishedRevisionId: "rev-1",
        }),
      },
      agent_run_id: RUN.id,
    }),
  });
}

type HandlerArg = { actor: Record<string, unknown>; input: Record<string, unknown> };

async function handlerActor(): Promise<Record<string, unknown>> {
  const res = await POST(writeAddressRequest());
  expect(res.status).toBe(200);
  expect(h.objectsUpdate).toHaveBeenCalledTimes(1);
  return (h.objectsUpdate.mock.calls[0]![0] as HandlerArg).actor;
}

beforeEach(() => {
  RUN.oboCeiling = null;
  h.readAgentRunById.mockReset().mockImplementation(async () => ({ ...RUN }));
  h.objectsUpdate.mockReset().mockResolvedValue({ ok: true, changeSetId: "cs-1" });
  h.resolveRunOwnerMembershipOrgRole.mockReset().mockResolvedValue("org_owner");
});

afterAll(() => {
  for (const m of [
    "server-only",
    "@cinatra-ai/agents",
    "@/lib/primitive-handlers",
    "@/lib/wayflow-bridge-auth",
    "@/lib/authz/bridge-run-binding",
    "@/lib/authz/build-actor-context-from-run",
    "@cinatra-ai/llm/actor-context",
  ]) {
    vi.doUnmock(m);
  }
  vi.resetModules();
});

describe("cinatra#4313: the primitive actor carries the owner's membership role", () => {
  it("stamps the role read from the run org's membership row, beside that org", async () => {
    const res = await POST(writeAddressRequest());
    expect(res.status).toBe(200);
    expect(h.resolveRunOwnerMembershipOrgRole).toHaveBeenCalledWith({
      orgId: "org-1",
      runBy: "user-1",
    });
    const arg = h.objectsUpdate.mock.calls[0]![0] as HandlerArg;
    expect(arg.actor.orgId).toBe("org-1");
    expect(arg.actor.orgRole).toBe("org_owner");
    // The seam still parses the patch text into the object it merges.
    expect(arg.input.data).toEqual({
      wordpressPublishedUrl: "https://blog.example.com/?page_id=9",
      wordpressPublishedExternalId: "9",
      wordpressPublishedRevisionId: "rev-1",
    });
  });

  it("lets an org owner's run update an organization-owned row through the real kernel", async () => {
    const actor = await handlerActor();
    await expect(
      enforceResourceAccess(ORG_OWNED_ARTIFACT, actor as never, "object.update"),
    ).resolves.toBeUndefined();
  });

  it("keeps a member's run refused on an organization-owned row", async () => {
    h.resolveRunOwnerMembershipOrgRole.mockResolvedValue("member");
    const actor = await handlerActor();
    expect(actor.orgRole).toBe("member");
    await expect(
      enforceResourceAccess(ORG_OWNED_ARTIFACT, actor as never, "object.update"),
    ).rejects.toMatchObject({ name: "AuthzError" });
  });

  it("stamps no role for a departed owner (no membership row), not the builder's member floor", async () => {
    h.resolveRunOwnerMembershipOrgRole.mockResolvedValue(undefined);
    const actor = await handlerActor();
    expect(actor).not.toHaveProperty("orgRole");
    await expect(
      enforceResourceAccess(ORG_OWNED_ARTIFACT, actor as never, "object.update"),
    ).rejects.toMatchObject({ name: "AuthzError" });
  });

  it("stamps no role and still answers the call when the membership read throws", async () => {
    h.resolveRunOwnerMembershipOrgRole.mockRejectedValue(new Error("db down"));
    const actor = await handlerActor();
    expect(actor).not.toHaveProperty("orgRole");
  });
});

describe("cinatra#4313: the primitive actor carries the run's OBO ceiling", () => {
  it("stamps no ceiling for a run that has none", async () => {
    const actor = await handlerActor();
    expect(actor).not.toHaveProperty("oboCeiling");
  });

  it("stamps the run's ceiling, and the kernel refuses an org owner's run outside it", async () => {
    // An org-owned row tagged to project P2; the agent is anchored to project P1.
    RUN.oboCeiling = [
      { tier: "project", id: "proj-P1" },
      { tier: "organization", id: "org-1" },
    ];
    const actor = await handlerActor();
    expect(actor.orgRole).toBe("org_owner");
    expect(actor.oboCeiling).toEqual(RUN.oboCeiling);
    await expect(
      enforceResourceAccess(
        { ...ORG_OWNED_ARTIFACT, projectId: "proj-P2" },
        actor as never,
        "object.update",
      ),
    ).rejects.toMatchObject({ name: "AuthzError" });
  });
});
