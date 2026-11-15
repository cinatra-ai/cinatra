/**
 * The `result_input_passthrough` echo of an objects_save ApiNode carries the
 * id of the saved object in the field the node declares (`result_id_field`).
 *
 * objects_save returns the new id as `objectId`; it has no `id`. The echo read
 * only `result.id` and the declared field, so the declared field was null for
 * every saved object. In the outreach flow that field is `campaignId`, and the
 * send confirmation then drew "No campaign selected yet" for every campaign.
 *
 * Drives the real route; the run store, the bridge auth, the run binding, the
 * actor builder and the primitive handlers are test doubles. The objects_save
 * double returns the shape the real handler returns, and the type check below
 * pins it to that handler's return type.
 *
 *   pnpm exec vitest run src/app/api/agents/passthrough/__tests__/passthrough-objects-save-echo-id.test.ts
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  objectsSave: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunById: h.readAgentRunById,
  publishCallAllowed: async () => true, // cinatra#4150: no publish decision holds this run
}));
vi.mock("@/lib/primitive-handlers", () => ({
  collectAllPrimitiveHandlers: async () => ({ objects_save: h.objectsSave }),
}));
vi.mock("@/lib/wayflow-bridge-auth", () => ({ isAuthorizedBridgeRequest: () => true }));
vi.mock("@/lib/authz/bridge-run-binding", () => ({
  bindBridgeRunId: async () => ({ ok: true, runId: "run-echo" }),
}));
vi.mock("@/lib/authz/build-actor-context-from-run", () => ({
  buildActorContextFromRun: vi.fn(async () => ({
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: "org-1",
    platformRole: "member",
  })),
}));
vi.mock("@cinatra-ai/llm/actor-context", () => ({
  withActorContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

import { POST } from "@/app/api/agents/passthrough/route";
import type { createObjectsPrimitiveHandlers } from "@cinatra-ai/objects/mcp-handlers";

// The real objects_save handler's return type. The double below must satisfy
// it, so a double with an `id` key (a shape the handler never returns) or
// without `objectId` fails the typecheck.
type ObjectsSaveResult = Awaited<
  ReturnType<ReturnType<typeof createObjectsPrimitiveHandlers>["objects_save"]>
>;
const SAVED = {
  objectId: "obj-1",
  type: "@cinatra-ai/campaigns:context",
  isNew: true,
} satisfies Partial<ObjectsSaveResult> & Pick<ObjectsSaveResult, "objectId">;

const RUN = { id: "run-echo", orgId: "org-1", runBy: "user-1", oboCeiling: null };
const PLAIN = { typeHint: "@cinatra-ai/campaigns:context", rawData: { name: "Plain" } };

function echoReq(input: Record<string, unknown>, idField?: string) {
  return new Request("http://localhost:3000/api/agents/passthrough", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cinatra-a2a-context-id": "ctx-echo" },
    body: JSON.stringify({
      tool: "objects_save",
      input,
      agent_run_id: RUN.id,
      result_input_passthrough: true,
      ...(idField === undefined ? {} : { result_id_field: idField }),
    }),
  });
}

beforeEach(() => {
  h.readAgentRunById.mockReset().mockResolvedValue(RUN);
  h.objectsSave.mockReset().mockResolvedValue(SAVED);
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

describe("the objects_save passthrough echo carries the saved object's id", () => {
  it("sets the declared id field to the objectId that objects_save returns", async () => {
    const res = await POST(echoReq(PLAIN, "campaignId"));
    expect(res.status).toBe(200);
    expect(h.objectsSave).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ name: "Plain", campaignId: "obj-1" });
  });

  it("carries the campaign id on the outreach context setup echo", async () => {
    const res = await POST(
      echoReq(
        {
          _shape: "email_outreach_context_setup",
          setupJson: JSON.stringify({
            offeringCompanyWebsite: "https://www.example.com/x",
            callToAction: "Book a call",
            senderName: "Ada",
          }),
          cinatra_agent_run_id: RUN.id,
        },
        "campaignId",
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.campaignId).toBe("obj-1");
    expect(body.cinatra_agent_run_id).toBe(RUN.id);
  });

  it("uses id as the field name when the node declares none", async () => {
    const res = await POST(echoReq(PLAIN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe("obj-1");
  });

  it("keeps reading id from a result that carries one", async () => {
    h.objectsSave.mockResolvedValueOnce({ id: "id-1" });
    const res = await POST(echoReq(PLAIN, "campaignId"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.campaignId).toBe("id-1");
  });

  it("echoes null when the result carries no id", async () => {
    h.objectsSave.mockResolvedValueOnce({});
    const res = await POST(echoReq(PLAIN, "campaignId"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.campaignId).toBeNull();
  });
});
