/**
 * cinatra#3745 — the passthrough road serves the campaign send only as the call of a released publishing step, uses
 * the person's decision once right before the effect, and binds the call's arguments to what the person reviewed.
 *
 * Drives the real route, the real run binding, the real argument preparation, the real outward-action check
 * (checkOutwardRunAction) and the send package's real handler table (its argument schema). The run store with the
 * single-use consumption, the publish-call check, the send's use cases, the bridge-auth check, the actor builder and
 * the run-authority mint are test doubles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

const h = vi.hoisted(() => {
  class RunStepToolPolicyRefusal extends Error {
    constructor(readonly code: string) { super(code); this.name = "RunStepToolPolicyRefusal"; }
  }
  return {
    RunStepToolPolicyRefusal,
    order: [] as string[],
    consumed: new Set<string>(),
    claim: true,
    readAgentRunById: vi.fn(),
    readAgentRunByContextId: vi.fn(),
    verifyRunExecutedSource: vi.fn(),
    consumeRunActionDecision: vi.fn(),
    startInitialSend: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/agents", () => ({
  // The call check: a released decision of the step, claimed for this call, unless the case says the step has none.
  publishCallAllowed: async (_run: unknown, _step: unknown, hold: (r: () => Promise<void>, c?: unknown) => void) => {
    if (h.claim) hold(async () => {}, { decisionId: "decision-1" });
    return true;
  },
  readAgentRunById: h.readAgentRunById,
  readAgentRunByContextId: h.readAgentRunByContextId,
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  verifyRunExecutedSource: h.verifyRunExecutedSource,
  readCurrentRunStepToolPolicy: async () => ({ source: "bound-source-under-test" }),
  assertRunStepToolAllowed: () => ({ kind: "declared", tools: ["email_outreach_send_initial_start"] }),
  consumeRunActionDecision: h.consumeRunActionDecision,
  RunStepToolPolicyRefusal: h.RunStepToolPolicyRefusal,
}));
vi.mock("@/lib/org-write/run-authority-mint", () => ({
  mintRunWriteAuthorityForMcp: vi.fn(async () => Object.freeze({ authority: "run-authority-under-test" })),
}));
vi.mock("@/lib/trigger-email-send-use-cases", async () => ({
  // The send's own up-front input check is the real one; its use cases are doubles.
  ...(await vi.importActual<typeof import("@/lib/trigger-email-send-use-cases")>("@/lib/trigger-email-send-use-cases")),
  createTriggerEmailSendUseCases: () => ({ startInitialSend: h.startInitialSend }),
}));
vi.mock("@cinatra-ai/a2a", () => ({ resolveLatestWayflowGateTaskId: vi.fn(async () => null) }));
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
vi.mock("@/lib/primitive-handlers", () => ({ collectAllPrimitiveHandlers: async () => ({}) }));

import { POST } from "@/app/api/agents/passthrough/route";
import { HOST_PRIMITIVE_OWNER_PACKAGE, HOST_PRIMITIVE_RELEASE_VERSION } from "@cinatra-ai/mcp-server/capability-plan";

const TOOL = "email_outreach_send_initial_start"; // the tool the send package declares (passthroughPublishingStep)
const ATTEST_KEY = "step-attest-key-under-test";
const CTX = "ctx-run-1";
const NODE = "send";
const RUN = { id: "run-1", orgId: "org-1", runBy: "user-1", templateId: "tpl-1", packageVersion: null, oboCeiling: null };
const SOURCE = { sourceSha256: "b".repeat(64), executedSourceSha256: "c".repeat(64), declarationSourceSha256: "d".repeat(64) };
const VERIFIED_SOURCE = Object.freeze({ contextId: CTX, stepId: NODE, executionAttemptId: "attempt-1", ...SOURCE });
const INPUT = {
  campaignId: "campaign-1",
  senderEmail: "me@example.com",
  approvedDraftBundleRef: "11111111-1111-4111-8111-111111111111",
  confirmedRecipientsRef: "22222222-2222-4222-8222-222222222222",
};
const ATTEST_BEFORE = process.env.CINATRA_CONTEXT_ATTEST_KEY;

function sourceHeaders(decision?: { id: string; sig?: string | null }): Record<string, string> {
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const sig = createHmac("sha256", ATTEST_KEY)
    .update(`s2\n${CTX}\n${NODE}\nattempt-1\n${SOURCE.sourceSha256}\n${SOURCE.executedSourceSha256}\n${SOURCE.declarationSourceSha256}\n${expiry}`)
    .digest("hex");
  // The runtime's signed decision of this visit (s3), over the same pair; `sig: null` sends no signature.
  const decisionHeaders: Record<string, string> = {};
  if (decision) {
    decisionHeaders["x-cinatra-publish-decision"] = decision.id;
    const s3 = decision.sig !== undefined ? decision.sig : createHmac("sha256", ATTEST_KEY)
      .update(`s3\n${CTX}\n${NODE}\nattempt-1\n${SOURCE.sourceSha256}\n${SOURCE.executedSourceSha256}\n` +
        `${SOURCE.declarationSourceSha256}\n${decision.id}\n${sig}\n${expiry}`).digest("hex");
    if (s3 !== null) decisionHeaders["x-cinatra-publish-decision-attestation"] = `s3:${expiry}:${s3}`;
  }
  return {
    ...decisionHeaders,
    "x-cinatra-step-node": NODE,
    "x-cinatra-execution-attempt": "attempt-1",
    "x-cinatra-step-attestation": `s2:${expiry}:${sig}`,
    "x-cinatra-raw-source": SOURCE.sourceSha256,
    "x-cinatra-executed-source": SOURCE.executedSourceSha256,
    "x-cinatra-declaration-source": SOURCE.declarationSourceSha256,
  };
}

function stepOnlyHeaders(): Record<string, string> {
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const sig = createHmac("sha256", ATTEST_KEY).update(`s1\n${CTX}\n${NODE}\n${expiry}`).digest("hex");
  return { "x-cinatra-step-node": NODE, "x-cinatra-step-attestation": `s1:${expiry}:${sig}` };
}

function makeReq(headers: Record<string, string>, input: unknown = INPUT): Request {
  return new Request("http://localhost:3000/api/agents/passthrough", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cinatra-a2a-context-id": CTX, ...headers },
    body: JSON.stringify({ tool: TOOL, input, agent_run_id: RUN.id }),
  });
}

beforeEach(() => {
  h.order.length = 0;
  h.claim = true;
  h.readAgentRunById.mockReset().mockResolvedValue(RUN);
  h.readAgentRunByContextId.mockReset().mockImplementation(async (ctx: string) => (ctx === CTX ? RUN : null));
  h.verifyRunExecutedSource.mockReset().mockResolvedValue(VERIFIED_SOURCE);
  h.consumed.clear();
  h.consumeRunActionDecision.mockReset().mockImplementation(async () => { h.order.push("consumed"); return {}; });
  h.startInitialSend.mockReset().mockImplementation(async () => { h.order.push("sent"); return { status: "completed" }; });
  process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_KEY;
});

afterEach(() => {
  if (ATTEST_BEFORE === undefined) delete process.env.CINATRA_CONTEXT_ATTEST_KEY;
  else process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_BEFORE;
});

describe("the campaign send on the passthrough road", () => {
  it("a released publishing step's call uses the decision once, bound to its arguments, before the send", async () => {
    const res = await POST(makeReq(sourceHeaders()));
    expect(res.status).toBe(200);
    expect(h.order).toEqual(["consumed", "sent"]);
    expect(h.consumeRunActionDecision).toHaveBeenCalledTimes(1);
    const [used] = h.consumeRunActionDecision.mock.calls[0] as [Record<string, unknown>];
    expect(used).toMatchObject({
      orgId: RUN.orgId,
      runId: RUN.id,
      authority: { authority: "run-authority-under-test" },
      proof: VERIFIED_SOURCE,
      subject: null,
      arguments: {
        values: INPUT,
        shown: ["senderEmail"],
        routing: ["serviceId", "campaignId", "approvedDraftBundleRef", "confirmedRecipientsRef"],
      },
      action: {
        toolName: TOOL,
        packageName: HOST_PRIMITIVE_OWNER_PACKAGE,
        version: HOST_PRIMITIVE_RELEASE_VERSION,
        installId: "host-builtin",
        digest: "host-builtin",
      },
    });
    expect(h.startInitialSend.mock.calls[0]?.[0]).toMatchObject({ campaignId: INPUT.campaignId, senderEmail: INPUT.senderEmail });
  });

  it("a refused decision answers the fixed 403 with its code, and nothing is sent", async () => {
    h.consumeRunActionDecision.mockImplementation(async () => {
      throw new h.RunStepToolPolicyRefusal("action_arguments_not_released");
    });
    const res = await POST(makeReq(sourceHeaders()));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "The run's tool call was refused.", code: "action_arguments_not_released" });
    expect(h.startInitialSend).not.toHaveBeenCalled();
  });

  it("a step that no released decision governs is refused before anything runs", async () => {
    h.claim = false;
    const res = await POST(makeReq(sourceHeaders()));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe("publishing_step_required");
    expect(h.consumeRunActionDecision).not.toHaveBeenCalled();
    expect(h.startInitialSend).not.toHaveBeenCalled();
  });

  it("a call without the executing-source proof is refused before anything runs", async () => {
    const res = await POST(makeReq(stepOnlyHeaders()));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe("publishing_step_required");
    expect(h.consumeRunActionDecision).not.toHaveBeenCalled();
    expect(h.startInitialSend).not.toHaveBeenCalled();
  });

  it("a tool of the same package that it does not declare stays off the road", async () => {
    const req = new Request("http://localhost:3000/api/agents/passthrough", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cinatra-a2a-context-id": CTX, ...sourceHeaders() },
      body: JSON.stringify({ tool: "email_outreach_send_initial_cancel", input: { campaignId: "c-1" }, agent_run_id: RUN.id }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: string }).error).toMatch(/not on the deterministic-passthrough allowlist/);
    expect(h.consumeRunActionDecision).not.toHaveBeenCalled();
  });

  it("arguments the send refuses use no decision", async () => {
    const res = await POST(makeReq(sourceHeaders(), { senderEmail: "me@example.com" }));
    expect(res.status).not.toBe(200);
    expect(h.consumeRunActionDecision).not.toHaveBeenCalled();
    expect(h.startInitialSend).not.toHaveBeenCalled();
  });

  /** The consumption as the store answers when the step's node holds two current decisions in the attempt. */
  function twoDecisionsOfOneStep(): void {
    h.consumeRunActionDecision.mockImplementation(async (used: { publishDecisionId?: string }) => {
      if (used.publishDecisionId === undefined) throw new h.RunStepToolPolicyRefusal("action_decision_binding_missing");
      if (h.consumed.has(used.publishDecisionId)) throw new h.RunStepToolPolicyRefusal("action_person_decision_already_consumed");
      h.consumed.add(used.publishDecisionId);
      h.order.push(`consumed:${used.publishDecisionId}`);
      return {};
    });
  }

  it("two visits of one step in an attempt each send on their own signed decision", async () => {
    twoDecisionsOfOneStep();
    const first = await POST(makeReq(sourceHeaders({ id: "decision-1" })));
    const second = await POST(makeReq(sourceHeaders({ id: "decision-2" })));
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(h.order).toEqual(["consumed:decision-1", "sent", "consumed:decision-2", "sent"]);
  });

  it("a decision named with a bad or missing signature is refused before anything runs", async () => {
    for (const sig of ["0".repeat(64), null]) {
      const res = await POST(makeReq(sourceHeaders({ id: "decision-1", sig })));
      expect(res.status).toBe(403);
    }
    expect(h.consumeRunActionDecision).not.toHaveBeenCalled();
    expect(h.startInitialSend).not.toHaveBeenCalled();
  });

  it("a call missing a bundle reference uses no decision, and the corrected call then sends", async () => {
    // The step's node holds one decision: the call's visit is that one, signed or not.
    h.consumeRunActionDecision.mockImplementation(async () => {
      if (h.consumed.has("decision-1")) throw new h.RunStepToolPolicyRefusal("action_person_decision_already_consumed");
      h.consumed.add("decision-1");
      h.order.push("consumed:decision-1");
      return {};
    });
    const { confirmedRecipientsRef: _dropped, ...missing } = INPUT;
    const refused = await POST(makeReq(sourceHeaders(), missing));
    expect(refused.status).not.toBe(200);
    expect(h.consumed.size).toBe(0);
    expect(h.startInitialSend).not.toHaveBeenCalled();
    const corrected = await POST(makeReq(sourceHeaders()));
    expect(corrected.status).toBe(200);
    expect(h.order).toEqual(["consumed:decision-1", "sent"]);
  });
});
