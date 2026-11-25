/**
 * cinatra#3089: the passthrough road serves a primitive that is not on its
 * allowlist when, and only when, the primitive's owning package declares in its
 * metadata that it may be served there as a declared publishing step's call,
 * AND the verified calling step is a listed publishing step of the run's
 * compiled flow whose newest decision reads `released`.
 *
 * Drives the real route, the real run binding, the real declaration reader and
 * the owning package's real metadata, handlers and argument schema. The run
 * store, the publish-decision reads, the bridge-auth check, the actor builder
 * and the send's use cases are test doubles. The decision doubles follow the
 * matrix the agents package pins for both reads
 * (packages/agents/src/__tests__/publish-call-guard.test.ts and
 * publishing-step-call-released-3089.test.ts).
 */
// red-first-expect: expected 403 to be 200
import { afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

type Decision = { listed: boolean; status: string | null };

const h = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByContextId: vi.fn(),
  decision: { listed: true, status: "released" } as { listed: boolean; status: string | null },
  publishCallAllowed: vi.fn(),
  releasedPublishingStepDecisionId: vi.fn(),
  claimPublishingStepCall: vi.fn(),
  sends: [] as Array<{ input: unknown; actor: unknown; frame: unknown }>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/agents", () => ({
  publishCallAllowed: h.publishCallAllowed,
  releasedPublishingStepDecisionId: h.releasedPublishingStepDecisionId,
  claimPublishingStepCall: h.claimPublishingStepCall,
  readAgentRunById: h.readAgentRunById,
  readAgentRunByContextId: h.readAgentRunByContextId,
}));
vi.mock("@cinatra-ai/a2a", () => ({ resolveLatestWayflowGateTaskId: vi.fn(async () => null) }));
vi.mock("@cinatra-ai/mcp-server", async () => {
  const actual = await vi.importActual<typeof import("@cinatra-ai/mcp-server/request-context")>(
    "@cinatra-ai/mcp-server/request-context",
  );
  return { mcpRequestContextStorage: actual.mcpRequestContextStorage };
});
vi.mock("@cinatra-ai/llm/actor-context", () => ({
  withActorContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/wayflow-bridge-auth", () => ({ isAuthorizedBridgeRequest: () => true }));
vi.mock("@/lib/authz/build-actor-context-from-run", () => ({
  buildActorContextFromRun: vi.fn(async () => ({
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: "org-1",
    platformRole: "member",
  })),
  resolveRunOwnerMembershipOrgRole: vi.fn(async () => undefined),
}));
vi.mock("@/lib/extension-scoped-tools", () => ({ EXTENSION_SCOPED_TOOLS: new Set<string>() }));
vi.mock("@/lib/run-folder-tools", () => ({ RUN_FOLDER_TOOLS: new Set<string>() }));
vi.mock("@/lib/primitive-handlers", () => ({
  collectAllPrimitiveHandlers: async () => ({ trigger_config_set: async () => ({ ok: true }) }),
}));
vi.mock("@/lib/extension-host-context", () => ({
  prepareDeclaredRunToolArguments: async (_tool: string, input: unknown) => input,
  OutwardActionRefusal: class OutwardActionRefusal extends Error {
    constructor(readonly code: string) { super(code); this.name = "OutwardActionRefusal"; }
  },
}));
vi.mock("@/lib/trigger-email-send-use-cases", async () => {
  const { mcpRequestContextStorage } = await vi.importActual<
    typeof import("@cinatra-ai/mcp-server/request-context")
  >("@cinatra-ai/mcp-server/request-context");
  return {
    createTriggerEmailSendUseCases: () => ({
      startInitialSend: async (input: unknown, actor: unknown) => {
        h.sends.push({ input, actor, frame: mcpRequestContextStorage.getStore() });
        return { operationId: "camp-1", kind: "initial_send", status: "completed" };
      },
    }),
  };
});

import { POST } from "@/app/api/agents/passthrough/route";

const ATTEST_KEY = "step-attest-key-under-test";
const CTX = "ctx-run-1";
const NODE = "send_campaign";
const RUN = { id: "run-1", orgId: "org-1", runBy: "user-1", templateId: "tpl-1", packageVersion: null, oboCeiling: null };
const SEND = "email_outreach_send_initial_start";
const SEND_INPUT = {
  campaignId: "camp-1",
  approvedDraftBundleRef: "11111111-1111-4111-8111-111111111111",
  confirmedRecipientsRef: "22222222-2222-4222-8222-222222222222",
};
const ATTEST_BEFORE = process.env.CINATRA_CONTEXT_ATTEST_KEY;

function stepHeaders(node = NODE) {
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const sig = createHmac("sha256", ATTEST_KEY).update(`s1\n${CTX}\n${node}\n${expiry}`).digest("hex");
  return { "x-cinatra-step-node": node, "x-cinatra-step-attestation": `s1:${expiry}:${sig}` };
}

function makeReq(tool: string, headers: Record<string, string>, input: unknown = SEND_INPUT): Request {
  return new Request("http://localhost:3000/api/agents/passthrough", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cinatra-a2a-context-id": CTX, ...headers },
    body: JSON.stringify({ tool, input, agent_run_id: RUN.id }),
  });
}

// The two reads, over one decision state: publishCallAllowed serves a listed step only on `released` and a step that
// is not listed unless its row holds it; releasedPublishingStepDecisionId serves a listed step on `released` only.
function decide(d: Decision) {
  h.decision = d;
}

beforeEach(() => {
  h.sends.length = 0;
  h.readAgentRunById.mockReset().mockResolvedValue(RUN);
  h.readAgentRunByContextId.mockReset().mockImplementation(async (ctx: string) => (ctx === CTX ? RUN : null));
  h.publishCallAllowed.mockReset().mockImplementation(async (_run: unknown, step: string | undefined) => {
    if (step === undefined) return false;
    const { listed, status } = h.decision;
    if (status !== null) return status === "released";
    return !listed;
  });
  h.releasedPublishingStepDecisionId.mockReset().mockImplementation(async (_run: unknown, step: string | undefined) =>
    step !== undefined && h.decision.listed && h.decision.status === "released" ? "decision-1" : null,
  );
  // Each call claims its decision afresh here; the once-per-decision rule is pinned in
  // passthrough-publishing-step-once-3089.test.ts.
  h.claimPublishingStepCall.mockReset().mockResolvedValue(true);
  decide({ listed: true, status: "released" });
  process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_KEY;
});

afterEach(() => {
  if (ATTEST_BEFORE === undefined) delete process.env.CINATRA_CONTEXT_ATTEST_KEY;
  else process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_BEFORE;
});

describe("a declared tool on the passthrough road", () => {
  it("called by a listed publishing step with a released decision reaches the handler with the run's actor and organisation", async () => {
    const res = await POST(makeReq(SEND, stepHeaders()));
    expect(res.status).toBe(200);
    expect(h.sends).toHaveLength(1);
    const [send] = h.sends;
    expect(send.input).toMatchObject({ campaignId: "camp-1", approvedDraftBundleRef: SEND_INPUT.approvedDraftBundleRef });
    expect(send.actor).toMatchObject({ actorType: "human", userId: "user-1", orgId: "org-1" });
    expect(send.frame).toMatchObject({ runId: RUN.id, userId: "user-1", orgId: "org-1", verifiedStepId: NODE });
    expect(h.releasedPublishingStepDecisionId).toHaveBeenCalledTimes(1);
    const [run, step] = h.releasedPublishingStepDecisionId.mock.calls[0] as [{ id: string; templateId: string }, unknown];
    expect(run).toMatchObject({ id: RUN.id, templateId: RUN.templateId });
    expect(step).toBe(NODE);
  });

  it("called by a step that is not listed is refused, also when a released decision exists for it", async () => {
    for (const status of ["released", null]) {
      decide({ listed: false, status });
      const res = await POST(makeReq(SEND, stepHeaders()));
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code?: string; error?: string };
      expect(body.code).toBe("publishing_step_required");
      expect(JSON.stringify(body)).not.toMatch(new RegExp(`${RUN.id}|${NODE}|${CTX}`));
    }
    expect(h.sends).toHaveLength(0);
  });

  it.each(["parked", "declined", "expired", "run_ended", null])("is refused while the step's decision is %s", async (status) => {
    decide({ listed: true, status });
    const res = await POST(makeReq(SEND, stepHeaders()));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe("publish_not_released");
    expect(h.sends).toHaveLength(0);
  });

  it("a call with no verified step is refused before any tool runs", async () => {
    const res = await POST(makeReq(SEND, {}));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe("publish_not_released");
    expect(h.sends).toHaveLength(0);
  });

  it("arguments the owning package's schema refuses never reach the send", async () => {
    const res = await POST(makeReq(SEND, stepHeaders(), { campaignId: "" }));
    expect(res.status).toBe(500);
    expect(h.sends).toHaveLength(0);
    // The same step with the flow values the card showed is served.
    expect((await POST(makeReq(SEND, stepHeaders()))).status).toBe(200);
  });
});

describe("an undeclared tool that is not on the allowlist", () => {
  it.each(["email_outreach_send_initial_cancel", "email_outreach_send_test_start", "unknown_tool"])(
    "%s stays refused by the allowlist, while the declared send is served",
    async (tool) => {
      const res = await POST(makeReq(tool, stepHeaders()));
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error?: string }).error).toMatch(/not on the deterministic-passthrough allowlist/);
      expect(h.releasedPublishingStepDecisionId).not.toHaveBeenCalled();
      expect(h.sends).toHaveLength(0);
      expect((await POST(makeReq(SEND, stepHeaders()))).status).toBe(200);
    },
  );

  it("an allowlisted tool takes its road unchanged and is not asked the publishing-step question", async () => {
    decide({ listed: false, status: null });
    const res = await POST(makeReq("trigger_config_set", stepHeaders(), {}));
    expect(res.status).toBe(200);
    expect(h.releasedPublishingStepDecisionId).not.toHaveBeenCalled();
    // The declared send from the same step is refused: the step is not a listed publishing step.
    const send = await POST(makeReq(SEND, stepHeaders()));
    expect(send.status).toBe(403);
    expect(((await send.json()) as { code?: string }).code).toBe("publishing_step_required");
  });
});

afterAll(() => {
  vi.doUnmock("server-only");
  vi.doUnmock("@cinatra-ai/agents");
  vi.doUnmock("@cinatra-ai/a2a");
  vi.doUnmock("@cinatra-ai/mcp-server");
  vi.doUnmock("@cinatra-ai/llm/actor-context");
  vi.doUnmock("@/lib/wayflow-bridge-auth");
  vi.doUnmock("@/lib/authz/build-actor-context-from-run");
  vi.doUnmock("@/lib/extension-scoped-tools");
  vi.doUnmock("@/lib/run-folder-tools");
  vi.doUnmock("@/lib/primitive-handlers");
  vi.doUnmock("@/lib/extension-host-context");
  vi.doUnmock("@/lib/trigger-email-send-use-cases");
  vi.resetModules();
});
