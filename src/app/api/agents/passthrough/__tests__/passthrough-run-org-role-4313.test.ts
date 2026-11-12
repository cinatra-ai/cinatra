/**
 * cinatra#4313: the passthrough hands the run's org role to the primitive.
 *
 * The publish agent's write_address step merges the page address onto the
 * post artifact through objects_update. That handler asks the resource kernel
 * for object.update on the artifact row, and a run's output row is owned by
 * the organization. The kernel grants object.update on an organization-owned
 * row only to an org admin or owner. The run-derived actor context resolves
 * the run owner's org role, but the passthrough built the primitive actor
 * without it, so the kernel saw a member and refused the write of an org
 * owner's own run (an AuthzError, answered 500).
 *
 * Drives the real route; the run store, the bridge auth, the run binding, the
 * actor builder and the primitive handlers are test doubles. The second case
 * puts the actor the handler receives through the real resource kernel.
 *
 *   pnpm exec vitest run src/app/api/agents/passthrough/__tests__/passthrough-run-org-role-4313.test.ts
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  objectsUpdate: vi.fn(),
  orgRole: "org_owner" as "org_owner" | "org_admin" | "member",
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
  buildActorContextFromRun: vi.fn(async () => ({
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: "org-1",
    platformRole: "member",
    orgRole: h.orgRole,
  })),
}));
vi.mock("@cinatra-ai/llm/actor-context", () => ({
  withActorContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

import { POST } from "@/app/api/agents/passthrough/route";
import { enforceResourceAccess } from "@/lib/authz/enforce-resource-access";

const RUN = { id: "run-4313", orgId: "org-1", runBy: "user-1", oboCeiling: null };

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

beforeEach(() => {
  h.orgRole = "org_owner";
  h.readAgentRunById.mockReset().mockResolvedValue(RUN);
  h.objectsUpdate.mockReset().mockResolvedValue({ ok: true, changeSetId: "cs-1" });
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

type HandlerArg = { actor: Record<string, unknown>; input: Record<string, unknown> };

describe("cinatra#4313: the primitive actor carries the run owner's org role", () => {
  it("stamps the org role the run-derived actor context resolved, with its org", async () => {
    const res = await POST(writeAddressRequest());
    expect(res.status).toBe(200);
    expect(h.objectsUpdate).toHaveBeenCalledTimes(1);
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
    await POST(writeAddressRequest());
    const arg = h.objectsUpdate.mock.calls[0]![0] as HandlerArg;
    await expect(
      enforceResourceAccess(ORG_OWNED_ARTIFACT, arg.actor as never, "object.update"),
    ).resolves.toBeUndefined();
  });

  it("keeps a member's run refused on an organization-owned row", async () => {
    h.orgRole = "member";
    await POST(writeAddressRequest());
    const arg = h.objectsUpdate.mock.calls[0]![0] as HandlerArg;
    expect(arg.actor.orgRole).toBe("member");
    await expect(
      enforceResourceAccess(ORG_OWNED_ARTIFACT, arg.actor as never, "object.update"),
    ).rejects.toMatchObject({ name: "AuthzError" });
  });
});
