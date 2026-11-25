/**
 * cinatra#3089: a declared publishing step's tool call is performed AT MOST ONCE
 * per released decision, across roads. After the handler read its arguments and
 * before the tool's effect starts, the road uses the decision through the agents
 * package's single-use consumption (`consumeRunActionDecision`, cinatra#3745),
 * which records it under the ledger key `publish_decision:<decision id>`: the
 * key the guarded MCP road writes too. A decision already used answers a fixed
 * 409 and never reaches the effect; a use is not given back when the effect
 * fails.
 *
 * Drives the real route, the real run binding and source-bound step proof, the
 * real declaration reader, the real consumption caller and the owning package's
 * real metadata, handlers and argument schema. The run store, the
 * publish-decision reads, the consumption (a stand-in that keeps main's
 * contract: a proof and a run write authority are required, one key per
 * decision whatever the action, an already-used key is refused with
 * `action_person_decision_already_consumed`), the authority mint, the
 * bridge-auth check, the actor builder and the send's use cases are test
 * doubles. The real consumption's single key across actions is pinned in
 * packages/agents/src/__tests__/run-action-decision-consumption-3745.test.ts.
 */
// red-first-expect: expected 403 to be 200
import { afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

const h = vi.hoisted(() => {
  class RunStepToolPolicyRefusal extends Error {
    constructor(readonly code: string) { super(code); this.name = "RunStepToolPolicyRefusal"; }
  }
  return {
    RunStepToolPolicyRefusal,
    readAgentRunById: vi.fn(),
    readAgentRunByContextId: vi.fn(),
    publishCallAllowed: vi.fn(),
    publishingStepCallReleased: vi.fn(),
    verifyRunExecutedSource: vi.fn(),
    consumeRunActionDecision: vi.fn(),
    decisionId: "decision-1",
    ledger: new Map<string, unknown>(),
    consumptions: [] as Array<Record<string, unknown>>,
    sendFails: 0,
    sends: [] as Array<{ input: unknown; actor: unknown; frame: unknown }>,
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/agents", () => ({
  publishCallAllowed: h.publishCallAllowed,
  publishingStepCallReleased: h.publishingStepCallReleased,
  readAgentRunById: h.readAgentRunById,
  readAgentRunByContextId: h.readAgentRunByContextId,
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  verifyRunExecutedSource: h.verifyRunExecutedSource,
  consumeRunActionDecision: h.consumeRunActionDecision,
  RunStepToolPolicyRefusal: h.RunStepToolPolicyRefusal,
}));
vi.mock("@/lib/org-write/run-authority-mint", () => ({
  mintRunWriteAuthorityForMcp: vi.fn(async () => Object.freeze({ authority: "run-authority-under-test" })),
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
  runActionRefusalClassCode: (err: unknown) =>
    err instanceof h.RunStepToolPolicyRefusal ? (err as { code: string }).code : null,
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

const SOURCE = {
  sourceSha256: "b".repeat(64),
  executedSourceSha256: "c".repeat(64),
  declarationSourceSha256: "d".repeat(64),
};
const VERIFIED_SOURCE = Object.freeze({ contextId: CTX, stepId: NODE, executionAttemptId: "attempt-1", ...SOURCE });
const HOST_ACTION = {
  toolName: SEND,
  packageName: "@cinatra-ai/host",
  version: "2817.1.0",
  installId: "host-builtin",
  digest: "host-builtin",
};
const MCP_ACTION = { toolName: SEND, packageName: "@cinatra-ai/host", version: "2817.1.0", installId: "host-builtin",
  digest: "host-builtin" };

/** The source-bound pair the runtime signs over the step, its task's attempt and the executing source. */
function sourceHeaders(): Record<string, string> {
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const attempt = VERIFIED_SOURCE.executionAttemptId;
  const sig = createHmac("sha256", ATTEST_KEY)
    .update(`s2\n${CTX}\n${NODE}\n${attempt}\n${SOURCE.sourceSha256}\n${SOURCE.executedSourceSha256}\n${SOURCE.declarationSourceSha256}\n${expiry}`)
    .digest("hex");
  return {
    "x-cinatra-step-node": NODE,
    "x-cinatra-execution-attempt": attempt,
    "x-cinatra-step-attestation": `s2:${expiry}:${sig}`,
    "x-cinatra-raw-source": SOURCE.sourceSha256,
    "x-cinatra-executed-source": SOURCE.executedSourceSha256,
    "x-cinatra-declaration-source": SOURCE.declarationSourceSha256,
  };
}

function makeReq(input: unknown = SEND_INPUT): Request {
  return new Request("http://localhost:3000/api/agents/passthrough", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cinatra-a2a-context-id": CTX, ...sourceHeaders() },
    body: JSON.stringify({ tool: SEND, input, agent_run_id: RUN.id }),
  });
}

/** The consumption's contract on main (run-action-decision-consumption.ts): a proof and an authority are required;
 *  the newest released decision of the step is used once under `publish_decision:<id>`, whatever the action. */
async function consumeStandIn(input: { orgId?: string; runId?: string; authority?: unknown; proof?: { stepId?: string };
  action?: Record<string, unknown> }) {
  h.consumptions.push(input as Record<string, unknown>);
  if (!input.orgId || !input.runId || !input.authority || !input.proof || !input.action) {
    throw new h.RunStepToolPolicyRefusal("action_decision_input_invalid");
  }
  await Promise.resolve();
  const key = `publish_decision:${h.decisionId}`;
  if (h.ledger.has(key)) throw new h.RunStepToolPolicyRefusal("action_person_decision_already_consumed");
  h.ledger.set(key, input.action);
  return { consumptionKey: key, decisionId: h.decisionId, decidedBy: "user-7", stepId: input.proof.stepId,
    action: input.action };
}

beforeEach(() => {
  h.sends.length = 0;
  h.consumptions.length = 0;
  h.ledger.clear();
  h.sendFails = 0;
  h.decisionId = "decision-1";
  h.readAgentRunById.mockReset().mockResolvedValue(RUN);
  h.readAgentRunByContextId.mockReset().mockImplementation(async (ctx: string) => (ctx === CTX ? RUN : null));
  h.publishCallAllowed.mockReset().mockResolvedValue(true);
  h.publishingStepCallReleased.mockReset().mockResolvedValue(true);
  h.verifyRunExecutedSource.mockReset().mockResolvedValue(VERIFIED_SOURCE);
  h.consumeRunActionDecision.mockReset().mockImplementation(consumeStandIn);
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

  it("uses the decision through the consumption, with the run, its organisation, authority, proof and the tool", async () => {
    expect((await POST(makeReq())).status).toBe(200);
    expect(h.consumptions).toEqual([
      { orgId: RUN.orgId, runId: RUN.id, authority: { authority: "run-authority-under-test" }, proof: VERIFIED_SOURCE,
        action: HOST_ACTION },
    ]);
    expect([...h.ledger.keys()]).toEqual(["publish_decision:decision-1"]);
  });

  it("a concurrent pair reaches the send once", async () => {
    // The second call asks for the decision while the first call's use of it is still open.
    let entered!: () => void;
    let release!: () => void;
    const firstEntered = new Promise<void>((resolve) => (entered = resolve));
    const firstReleased = new Promise<void>((resolve) => (release = resolve));
    h.consumeRunActionDecision.mockImplementationOnce(async (input: Parameters<typeof consumeStandIn>[0]) => {
      entered();
      await firstReleased;
      return consumeStandIn(input);
    });
    const first = POST(makeReq());
    // A call that is answered without claiming does not hold the second one back.
    await Promise.race([firstEntered, first]);
    const second = POST(makeReq());
    await vi.waitFor(() => expect(h.consumptions).toHaveLength(1));
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
    expect(h.consumptions).toHaveLength(0);
    expect((await POST(makeReq())).status).toBe(200);
    expect(h.sends).toHaveLength(1);
  });

  it("a consumption the store cannot record is the run call's refusal, before the send", async () => {
    h.consumeRunActionDecision.mockRejectedValueOnce(new h.RunStepToolPolicyRefusal("action_person_decision_unavailable"));
    const res = await POST(makeReq());
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("action_person_decision_unavailable");
    expect(h.sends).toHaveLength(0);
  });
});

describe("one use per decision across roads", () => {
  it("a decision the guarded MCP road used makes the passthrough call answer 409", async () => {
    await h.consumeRunActionDecision({ orgId: RUN.orgId, runId: RUN.id, authority: { authority: "mcp" },
      proof: VERIFIED_SOURCE, action: MCP_ACTION });
    const res = await POST(makeReq());
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe(PERFORMED);
    expect(h.sends).toHaveLength(0);
  });

  it("a decision the passthrough call used is refused to the guarded MCP road", async () => {
    expect((await POST(makeReq())).status).toBe(200);
    await expect(
      h.consumeRunActionDecision({ orgId: RUN.orgId, runId: RUN.id, authority: { authority: "mcp" },
        proof: VERIFIED_SOURCE, action: MCP_ACTION }),
    ).rejects.toMatchObject({ code: "action_person_decision_already_consumed" });
    expect([...h.ledger.keys()]).toEqual(["publish_decision:decision-1"]);
  });
});

afterAll(() => {
  vi.doUnmock("server-only");
  vi.doUnmock("@cinatra-ai/agents");
  vi.doUnmock("@cinatra-ai/agents/store");
  vi.doUnmock("@/lib/org-write/run-authority-mint");
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
