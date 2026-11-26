/**
 * cinatra#4150 — the passthrough road serves the test send's plan, and tells the send's two call shapes apart.
 *
 *   - `campaign_test_send_plan` is admitted and runs in the run-scoped frame (the proven run and the gate submission),
 *     with the gate's envelope projected as the send's envelope is;
 *   - a send body that carries `planJson` (the plan a publish card showed) reaches the send as `pinnedPlanJson` alone;
 *     a body with the envelope reaches it exactly as before;
 *   - the form's shaped answer of a pinned send echoes the plan's recipient.
 *
 * Drives the real route and the real run binding; the run store, the handler registry, the bridge-auth check and the
 * actor builder are test doubles (the same seams as publish-not-released.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByContextId: vi.fn(),
  publishCallAllowed: vi.fn(async () => true),
  resolveLatestWayflowGateTaskId: vi.fn(async () => "task-gate-1" as string | null),
  observed: [] as Array<{ tool: string; input: Record<string, unknown>; frame: Record<string, unknown> | undefined }>,
  answer: { ok: true, seq: 4, message: "Test email sent to tester@example.com.", sentTo: "tester@example.com" } as unknown,
}));

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/agents", () => ({
  publishCallAllowed: h.publishCallAllowed,
  readAgentRunById: h.readAgentRunById,
  readAgentRunByContextId: h.readAgentRunByContextId,
}));
vi.mock("@cinatra-ai/a2a", () => ({ resolveLatestWayflowGateTaskId: h.resolveLatestWayflowGateTaskId }));
vi.mock("@cinatra-ai/mcp-server", async () => {
  const actual = await vi.importActual<typeof import("@cinatra-ai/mcp-server/request-context")>(
    "@cinatra-ai/mcp-server/request-context",
  );
  return { mcpRequestContextStorage: actual.mcpRequestContextStorage };
});
vi.mock("@cinatra-ai/llm/actor-context", () => ({ withActorContext: (_ctx: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/wayflow-bridge-auth", () => ({ isAuthorizedBridgeRequest: () => true }));
vi.mock("@/lib/authz/build-actor-context-from-run", () => ({
  buildActorContextFromRun: vi.fn(async () => ({
    principalType: "HumanUser", principalId: "user-1", organizationId: "org-1", platformRole: "member",
  })),
}));
vi.mock("@/lib/extension-scoped-tools", () => ({ EXTENSION_SCOPED_TOOLS: new Set<string>() }));
vi.mock("@/lib/run-folder-tools", () => ({ RUN_FOLDER_TOOLS: new Set<string>() }));
vi.mock("@/lib/primitive-handlers", async () => {
  const { mcpRequestContextStorage } = await vi.importActual<
    typeof import("@cinatra-ai/mcp-server/request-context")
  >("@cinatra-ai/mcp-server/request-context");
  const handler = (tool: string) => async (req: { input: Record<string, unknown> }) => {
    h.observed.push({ tool, input: req.input, frame: mcpRequestContextStorage.getStore() as Record<string, unknown> | undefined });
    return h.answer;
  };
  return {
    collectAllPrimitiveHandlers: async () => ({
      campaign_test_send_plan: handler("campaign_test_send_plan"),
      email_test_delivery_run_send: handler("email_test_delivery_run_send"),
    }),
  };
});
vi.mock("@/lib/extension-host-context", () => ({
  prepareDeclaredRunToolArguments: async (_tool: string, input: unknown) => input,
  OutwardActionRefusal: class OutwardActionRefusal extends Error {
    constructor(readonly code: string) { super(code); this.name = "OutwardActionRefusal"; }
  },
}));

import { POST } from "@/app/api/agents/passthrough/route";

const CTX = "ctx-run-1";
const RUN = { id: "run-1", orgId: "org-1", runBy: "user-1", templateId: "tpl-1", packageVersion: null, oboCeiling: null };
const ENVELOPE = JSON.stringify({
  action: "send", recipientEmail: "tester@example.com", selectionMode: "specific_initial", specificInitialDraftIds: ["d1"],
});
const PLAN_JSON = JSON.stringify({
  v: 1, campaignId: "c1", sender: { email: "s@example.com", name: "S" }, recipientEmail: "tester@example.com",
  drafts: [{ id: "d1", revision: "a".repeat(64) }],
});

function req(body: Record<string, unknown>): Request {
  return new Request("http://localhost:3000/api/agents/passthrough", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cinatra-a2a-context-id": CTX },
    body: JSON.stringify({ agent_run_id: RUN.id, ...body }),
  });
}

beforeEach(() => {
  h.observed.length = 0;
  h.readAgentRunById.mockReset().mockResolvedValue(RUN);
  h.readAgentRunByContextId.mockReset().mockImplementation(async (ctx: string) => (ctx === CTX ? RUN : null));
  h.resolveLatestWayflowGateTaskId.mockReset().mockResolvedValue("task-gate-1");
  h.publishCallAllowed.mockReset().mockResolvedValue(true);
});
afterEach(() => vi.clearAllMocks());

describe("the plan of a test send on the passthrough road", () => {
  it("is admitted, runs in the run-scoped frame with the gate submission, and takes the envelope", async () => {
    const res = await POST(req({ tool: "campaign_test_send_plan", input: { envelopeJson: ENVELOPE } }));
    expect(res.status).toBe(200);
    expect(h.observed).toHaveLength(1);
    const [call] = h.observed;
    expect(call!.tool).toBe("campaign_test_send_plan");
    expect(call!.input).toEqual({ recipientEmail: "tester@example.com", selectionMode: "specific_initial", specificInitialDraftIds: ["d1"] });
    expect(call!.frame).toMatchObject({ verifiedRunScopeId: RUN.id, verifiedSubmissionId: "task-gate-1", orgId: RUN.orgId });
  });
});

describe("the send's two call shapes", () => {
  it("a body with planJson reaches the send as pinnedPlanJson alone", async () => {
    const res = await POST(req({ tool: "email_test_delivery_run_send", input: { planJson: PLAN_JSON, envelopeJson: ENVELOPE } }));
    expect(res.status).toBe(200);
    expect(h.observed[0]!.input).toEqual({ pinnedPlanJson: PLAN_JSON });
  });

  it("a planJson that is not text reaches the send as an empty plan, which it refuses", async () => {
    await POST(req({ tool: "email_test_delivery_run_send", input: { planJson: { v: 1 } } }));
    expect(h.observed[0]!.input).toEqual({ pinnedPlanJson: "" });
  });

  it("a body with the envelope reaches the send exactly as before", async () => {
    await POST(req({ tool: "email_test_delivery_run_send", input: { envelopeJson: ENVELOPE } }));
    expect(h.observed[0]!.input).toEqual({ recipientEmail: "tester@example.com", selectionMode: "specific_initial", specificInitialDraftIds: ["d1"] });
  });

  it("the form's shaped answer of a pinned send echoes the plan's recipient", async () => {
    const res = await POST(req({ tool: "email_test_delivery_run_send", input: { planJson: PLAN_JSON }, result_shape: "test_delivery_send" }));
    expect(await res.json()).toEqual({
      lastSendResult: { ok: true, message: "Test email sent to tester@example.com.", sentTo: "tester@example.com" },
      gateCycle: 4,
      recipientEmail: "tester@example.com",
      selectionMode: "random_initial",
      specificInitialDraftIds: [],
      specificFollowUpDraftIds: [],
    });
  });
});
