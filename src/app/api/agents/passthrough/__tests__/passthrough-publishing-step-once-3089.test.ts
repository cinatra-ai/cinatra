/**
 * cinatra#3089: a declared publishing step's tool call is performed AT MOST ONCE
 * per released decision. Before the tool's effect starts, the road claims the
 * decision in the durable consumption ledger (one insert that only one caller
 * wins); a call that does not win answers a fixed 409 and never reaches the
 * effect, and a claimed decision is not given back when the effect fails.
 *
 * Drives the real route, the real run binding, the real declaration reader and
 * the owning package's real metadata, handlers and argument schema. The run
 * store, the publish-decision reads and the claim (an in-memory set standing in
 * for the ledger's conflict-free insert), the bridge-auth check, the actor
 * builder and the send's use cases are test doubles.
 */
// red-first-expect: expected 403 to be 200
import { afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

const h = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByContextId: vi.fn(),
  publishCallAllowed: vi.fn(),
  releasedPublishingStepDecisionId: vi.fn(),
  claimPublishingStepCall: vi.fn(),
  decisionId: "decision-1",
  consumed: new Set<string>(),
  claims: [] as unknown[],
  sendFails: 0,
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
        if (h.sendFails > 0) {
          h.sendFails -= 1;
          throw new Error("the mail provider did not answer");
        }
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
const PERFORMED = "publishing_step_call_performed";

function stepHeaders(node = NODE) {
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const sig = createHmac("sha256", ATTEST_KEY).update(`s1\n${CTX}\n${node}\n${expiry}`).digest("hex");
  return { "x-cinatra-step-node": node, "x-cinatra-step-attestation": `s1:${expiry}:${sig}` };
}

function makeReq(input: unknown = SEND_INPUT): Request {
  return new Request("http://localhost:3000/api/agents/passthrough", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cinatra-a2a-context-id": CTX, ...stepHeaders() },
    body: JSON.stringify({ tool: SEND, input, agent_run_id: RUN.id }),
  });
}

beforeEach(() => {
  h.sends.length = 0;
  h.claims.length = 0;
  h.consumed.clear();
  h.sendFails = 0;
  h.decisionId = "decision-1";
  h.readAgentRunById.mockReset().mockResolvedValue(RUN);
  h.readAgentRunByContextId.mockReset().mockImplementation(async (ctx: string) => (ctx === CTX ? RUN : null));
  h.publishCallAllowed.mockReset().mockResolvedValue(true);
  h.releasedPublishingStepDecisionId.mockReset().mockImplementation(async () => h.decisionId);
  // The ledger's insert: the first caller of a decision wins, every later one does not.
  h.claimPublishingStepCall.mockReset().mockImplementation(async (claim: { decisionId: string }) => {
    h.claims.push(claim);
    await Promise.resolve();
    if (h.consumed.has(claim.decisionId)) return false;
    h.consumed.add(claim.decisionId);
    return true;
  });
  process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_KEY;
});

afterEach(() => {
  if (ATTEST_BEFORE === undefined) delete process.env.CINATRA_CONTEXT_ATTEST_KEY;
  else process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_BEFORE;
});

async function codeOf(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { code?: string }).code;
}

describe("a declared publishing step's call, once per released decision", () => {
  it("the same signed call twice reaches the send once; the second answers 409 with a fixed code", async () => {
    const first = await POST(makeReq());
    expect(first.status).toBe(200);
    const second = await POST(makeReq());
    expect(second.status).toBe(409);
    const body = (await second.json()) as { code?: string; error?: string };
    expect(body.code).toBe(PERFORMED);
    expect(body.error).toBe("This publishing step's call was already performed for this decision.");
    expect(JSON.stringify(body)).not.toMatch(new RegExp(`${RUN.id}|${NODE}|${CTX}|decision-1`));
    expect(h.sends).toHaveLength(1);
  });

  it("claims the decision with the run, its organisation, the verified step and the tool", async () => {
    expect((await POST(makeReq())).status).toBe(200);
    expect(h.claims).toEqual([
      { decisionId: "decision-1", run: { id: RUN.id, orgId: RUN.orgId }, stepId: NODE, tool: SEND, executedSourceSha256: null },
    ]);
  });

  it("a concurrent pair reaches the send once", async () => {
    // The second call claims while the first call's claim is still open.
    let entered!: () => void;
    let release!: () => void;
    const firstEntered = new Promise<void>((resolve) => (entered = resolve));
    const firstReleased = new Promise<void>((resolve) => (release = resolve));
    const ledger = h.claimPublishingStepCall.getMockImplementation()!;
    h.claimPublishingStepCall.mockImplementationOnce(async (claim: { decisionId: string }) => {
      entered();
      await firstReleased;
      return ledger(claim);
    });
    const first = POST(makeReq());
    // A call that is answered without claiming does not hold the second one back.
    await Promise.race([firstEntered, first]);
    const second = POST(makeReq());
    await vi.waitFor(() => expect(h.claims).toHaveLength(1));
    release();
    const statuses = [(await first).status, (await second).status];
    expect(statuses.sort()).toEqual([200, 409]);
    expect(h.sends).toHaveLength(1);
  });

  it("a send that fails keeps the decision used: a retry answers 409 and never reaches the send", async () => {
    h.sendFails = 1;
    const first = await POST(makeReq());
    expect(first.status).toBe(500);
    expect(h.sends).toHaveLength(1);
    const retry = await POST(makeReq());
    expect(retry.status).toBe(409);
    expect(await codeOf(retry)).toBe(PERFORMED);
    expect(h.sends).toHaveLength(1);
  });

  it("a new release of the same step is a new decision, and its call reaches the send again", async () => {
    expect((await POST(makeReq())).status).toBe(200);
    h.decisionId = "decision-2";
    expect((await POST(makeReq())).status).toBe(200);
    expect(h.sends).toHaveLength(2);
    expect((await POST(makeReq())).status).toBe(409);
  });

  it("arguments the owning package's schema refuses use nothing: the call with the card's values is served after", async () => {
    const refused = await POST(makeReq({ campaignId: "" }));
    expect(refused.status).toBe(500);
    expect(h.claims).toHaveLength(0);
    expect((await POST(makeReq())).status).toBe(200);
    expect(h.sends).toHaveLength(1);
  });

  it("a claim that cannot be recorded refuses the call before the send", async () => {
    h.claimPublishingStepCall.mockRejectedValueOnce(new Error("db down"));
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    expect(h.sends).toHaveLength(0);
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
