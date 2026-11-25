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
import { readFileSync } from "node:fs";

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
    // Set by a test that drives the send's real use case with a provider stub: the addresses mailed, in order.
    provider: null as null | { mailed: string[]; failOn: string | null; refuseBodiesOnce?: boolean; records?: Map<string, { id: string; phase: "claimed" | "finalized" }> },
    // The real publishCallAllowed over a fake of the decision store (the run-row lock is a mutex; calls_in_flight is one number).
    realGuard: false,
    guard: { calls: 0, status: "released", lock: Promise.resolve() as Promise<unknown>, maxCalls: 0 },
    readAgentTemplateById: vi.fn(),
  };
});

// The send's real use case with a provider stub: three recipients, each with a body a person approved (the card's list).
// The stub records each address it is asked to mail and throws on the one named in `failOn`. The seams are the ones the
// send's own suites inject (src/lib/__tests__/send-approved-bodies-3089.test.ts): the objects reads, the approved-body
// reader, the decision the calling step holds, and the record of each message sent (shared by every call of a test).
const RECIPIENTS = ["one@example.test", "two@example.test", "three@example.test"];
const CAMPAIGN = "camp-1";
type Provider = { mailed: string[]; failOn: string | null; refuseBodiesOnce?: boolean; records?: Map<string, { id: string; phase: "claimed" | "finalized" }> };
type UseCaseParts = {
  refused: new (message: string) => Error;
  materialize: (args: never, deps: never) => Promise<unknown>;
  bodyType: string;
};
function providerDeps(provider: Provider, parts: UseCaseParts) {
  const bundle = (data: unknown) => ({ id: "bundle", type: "bundle", data });
  const approvedList = RECIPIENTS.map((to, i) => ({ artifactId: `art-${i + 1}`, representationRevisionId: `rev-${i + 1}`,
    contactId: `c${i + 1}`, recipientEmail: to, subject: `Subject ${i + 1}` }));
  const records = (provider.records ??= new Map());
  let next = records.size;
  return {
    getCampaign: async () => null,
    getDraftsByIds: async () => [],
    getObjectByRef: async (ref: string) =>
      bundle(ref.startsWith("1111")
        ? { cinatraAgentRunId: "run-1", drafts: RECIPIENTS.map((to, i) => ({ id: `d${i + 1}`, contactId: `c${i + 1}`, recipientId: `c${i + 1}`,
            recipientEmail: to, subject: `Subject ${i + 1}`, body: `Body ${i + 1}` })) }
        : { cinatraAgentRunId: "run-1", confirmedRecipients: RECIPIENTS.map((email, i) => ({ contactId: `c${i + 1}`, email })) }),
    // The writer of a message body refuses while another call of the same decision is in flight (the in-flight fence of
    // lifecycle-emit: the count is per decision, so two claims leave no call able to write).
    emitEmailFanout: async (args: never) => {
      if (h.guard.calls > 1) throw new parts.refused("a publishing call of this run is in flight");
      // A body the send refuses before any message is claimed or mailed.
      if (provider.refuseBodiesOnce) {
        provider.refuseBodiesOnce = false;
        throw new parts.refused("a body was refused");
      }
      return parts.materialize(args, {
        writeBody: async (w: { outputId: string }) => ({ ok: true, artifactId: `new-${w.outputId}`, representationRevisionId: `new-rev-${w.outputId}`, deduped: false }),
        bindBody: async (b: { artifactId: string; representationRevisionId: string }) => ({ ok: true, artifactId: b.artifactId,
          representationRevisionId: b.representationRevisionId, deduped: false }),
        registeredTypes: new Set([parts.bodyType]),
      } as never);
    },
    sendEmail: async (message: { to: string[] }) => {
      const to = message.to[0]!;
      if (to === provider.failOn) throw new Error(`the mail provider refused ${to}`);
      provider.mailed.push(to);
      return { providerId: "p", providerMessageId: `m-${provider.mailed.length}`, sentAt: "2026-11-25T00:00:00Z" };
    },
    // The approved form's seams. A send without them reads the bundle as before, so they change nothing there.
    readCallingRun: async () => ({ runId: "run-1", stepId: NODE_ID }),
    readPublishDecision: async () => ({
      status: "released", decidedBy: "user-2",
      surfacedValues: { campaignId: CAMPAIGN, recipients: approvedList.map((e) => ({ email: e.recipientEmail, subject: e.subject })), emailBodies: approvedList },
      declaredRows: [{ kind: "list", input: "recipients", columns: [{ field: "email" }, { field: "subject" }] }, { kind: "artifacts", input: "emailBodies" }],
    }),
    readDecidedBody: async (ref: { artifactId: string }) => {
      const i = Number(ref.artifactId.slice(4)) - 1;
      return { ok: true, text: `Body ${i + 1}`, data: { subject: `Subject ${i + 1}`, contactId: `c${i + 1}`, campaignId: CAMPAIGN } };
    },
    readRunReviewedBodies: async () => false,
    readObjectRuns: async () => ["run-1"],
    messageSendLedger: {
      async claim(m: { bindingOutputId: string }) {
        const row = records.get(m.bindingOutputId);
        if (row) return { kind: row.phase === "finalized" ? "done" : "in_doubt" };
        next += 1;
        records.set(m.bindingOutputId, { id: `send-${next}`, phase: "claimed" });
        return { kind: "won", ledgerId: `send-${next}` };
      },
      async markDone(id: string) {
        for (const row of records.values()) if (row.id === id && row.phase === "claimed") { row.phase = "finalized"; return true; }
        return false;
      },
      async release(id: string) {
        for (const [key, row] of records) if (row.id === id && row.phase === "claimed") records.delete(key);
      },
    },
  } as never;
}
const NODE_ID = "send_campaign";

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/agents", async () => {
  const real = await vi.importActual<typeof import("../../../../../../packages/agents/src/publish-decision-actions")>(
    "../../../../../../packages/agents/src/publish-decision-actions",
  );
  return {
    // A test that sets `h.realGuard` runs the agents package's own call check over the store fake below.
    publishCallAllowed: (...args: Parameters<typeof real.publishCallAllowed>) =>
      h.realGuard ? real.publishCallAllowed(...args) : h.publishCallAllowed(...args),
    publishingStepCallReleased: h.publishingStepCallReleased,
    readAgentRunById: h.readAgentRunById,
    readAgentRunByContextId: h.readAgentRunByContextId,
  };
});
vi.mock("@cinatra-ai/agents/store", () => ({
  verifyRunExecutedSource: h.verifyRunExecutedSource,
  RunStepToolPolicyRefusal: h.RunStepToolPolicyRefusal,
  // What the agents package's call check reads through the same module.
  readAgentRunById: h.readAgentRunById,
  readAgentTemplateById: h.readAgentTemplateById,
  readRunCoOwners: vi.fn(async () => []),
  transitionRunStatus: vi.fn(async () => undefined),
}));
vi.mock("../../../../../../packages/agents/src/db", () => ({ db: {} }));
// The pure readers of the store (the released list of a decision) stay real; its reads and writes are the fake.
vi.mock("../../../../../../packages/agents/src/publish-decision-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readDecisionForRunNode: async () => ({ id: "decision-1", orgId: "org-1", runId: "run-1", nodeId: "send_campaign",
    status: h.guard.status, runGeneration: 0 }),
  // The run row's lock: one holder at a time.
  withRunRowLock: (_runId: string, fn: (tx: unknown, run: unknown) => Promise<unknown>) => {
    const result = h.guard.lock.then(() => fn("tx", { orgId: "org-1", resetGeneration: 0 }));
    h.guard.lock = result.catch(() => undefined);
    return result;
  },
  claimPublishCall: async () => {
    h.guard.calls += 1;
    h.guard.maxCalls = Math.max(h.guard.maxCalls, h.guard.calls);
    return true;
  },
  claimPublishCallExclusive: async () => {
    if (h.guard.calls > 0) return false;
    h.guard.calls = 1;
    h.guard.maxCalls = Math.max(h.guard.maxCalls, h.guard.calls);
    return true;
  },
  publishCallsInFlight: async () => h.guard.calls,
  endPublishCall: async () => { h.guard.calls = Math.max(0, h.guard.calls - 1); },
  readLatestDecisionForRun: async () => null,
  readOpenDecisionForRun: async () => null,
  readRunBoundGraph: async () => null,
  readDispatchedPublishRows: async () => null,
  insertParkedDecision: vi.fn(),
  decide: vi.fn(),
  listDueParked: async () => [],
  listSettledWithWaitingRun: async () => [],
}));
// Mocked by its file, which the subpath `@cinatra-ai/agents/run-action-decision-consumption` resolves to.
vi.mock("../../../../../../packages/agents/src/run-action-decision-consumption", () => ({
  consumeRunActionDecision: h.consumeRunActionDecision,
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
  const actual = await vi.importActual<typeof import("@/lib/trigger-email-send-use-cases")>("@/lib/trigger-email-send-use-cases");
  return {
    createTriggerEmailSendUseCases: () => h.provider ? actual.createTriggerEmailSendUseCases(providerDeps(h.provider, { refused: actual.EmailBodyRefusedError, materialize: actual.materializeEmailFanout as never, bodyType: actual.EMAIL_BODY_TYPE_ID })) : ({
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

// The review store the call check reads (the gate seam): the attempt holds a review a person approved, and no output of it waits.
const APPROVED_REVIEW = { id: "gate-1", status: "resolved", disposition: "approve", createdAt: new Date("2026-11-01T00:00:00Z"),
  runGeneration: 0, fingerprint: "e".repeat(64), resolvedBy: "user-reviewer", successorGateId: null };
const seamSlot = globalThis as { __cinatraArtifactReviewGateSeam?: unknown };
const seamBefore = seamSlot.__cinatraArtifactReviewGateSeam;
seamSlot.__cinatraArtifactReviewGateSeam = {
  listReviews: vi.fn(async () => [APPROVED_REVIEW]),
  hasPendingProducedReview: vi.fn(async () => false),
};

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
  h.provider = null;
  h.realGuard = false;
  h.guard.calls = 0;
  h.guard.maxCalls = 0;
  h.guard.status = "released";
  h.guard.lock = Promise.resolve();
  h.readAgentTemplateById.mockReset().mockResolvedValue({ id: "tpl-1", publishingSteps: ["send_campaign"] });
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
    // The publishing-step check reads the flow the run executes: it is handed the verified executed-source proof.
    expect(h.publishingStepCallReleased).toHaveBeenCalledWith(RUN, NODE, VERIFIED_SOURCE);
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

describe("a send to several recipients that fails part way, through the send's real use case", () => {
  it("answers a failure and not HTTP 200, with the send's own answer; a retry of the decision mails nobody", async () => {
    // red-first-expect: to be 502
    h.provider = { mailed: [], failOn: RECIPIENTS[1]! };
    const first = await POST(makeReq());
    expect(first.status).toBe(502);
    const body = (await first.json()) as { code?: string; error?: string; status?: string };
    expect(body.code).toBe("publishing_step_call_failed");
    expect(body.status).toBe("failed");
    expect(typeof body.error === "string" && body.error !== "").toBe(true);
    // Recipient one went out once; the decision is used.
    expect(h.provider.mailed).toEqual([RECIPIENTS[0]]);
    const retry = await POST(makeReq());
    expect(retry.status).toBe(409);
    expect(await codeOf(retry)).toBe(PERFORMED);
    expect(h.provider.mailed).toEqual([RECIPIENTS[0]]);
  });

  it("answers 200 with the number sent when every recipient was mailed, each once", async () => {
    h.provider = { mailed: [], failOn: null };
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "completed", sentCount: 3 });
    expect(h.provider.mailed).toEqual(RECIPIENTS);
    expect((await POST(makeReq())).status).toBe(409);
    expect(h.provider.mailed).toEqual(RECIPIENTS);
  });
});

describe("concurrent calls of one released decision, through the agents package's real call check", () => {
  const N = 5;
  const fire = (count: number) => Promise.all(Array.from({ length: count }, () => POST(makeReq())));

  it("admits exactly one: it mails every recipient once, and every other call answers 409 and touches nothing", async () => {
    // red-first-expect: to deeply equal
    h.realGuard = true;
    h.provider = { mailed: [], failOn: null };
    const answers = await fire(N);
    expect(answers.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409]);
    expect(h.provider.mailed).toEqual(RECIPIENTS);
    // The claim was exclusive: no more than one call of the decision was ever in flight, and each one ended.
    expect(h.guard.maxCalls).toBe(1);
    expect(h.guard.calls).toBe(0);
    for (const refused of answers.filter((r) => r.status === 409)) {
      expect(JSON.stringify(await refused.json())).not.toMatch(new RegExp(`${RUN.id}|${NODE}|${CTX}|decision-1`));
    }
    // Later calls find the decision used: still 409, still nothing mailed.
    expect((await POST(makeReq())).status).toBe(409);
    expect(h.provider.mailed).toEqual(RECIPIENTS);
    expect(h.guard.calls).toBe(0);
  });

  it("a call whose arguments are refused takes nothing: the claim is ended and the same decision is still served", async () => {
    h.realGuard = true;
    h.provider = { mailed: [], failOn: null };
    expect((await POST(makeReq({ campaignId: "" }))).status).toBe(500);
    expect(h.guard.calls).toBe(0);
    expect(h.provider.mailed).toEqual([]);
    expect((await POST(makeReq())).status).toBe(200);
    expect(h.provider.mailed).toEqual(RECIPIENTS);
  });

  it("a call that consumed the decision and failed before any provider call: the claim ends, a retry of it is 409, and the person's next approval sends everything", async () => {
    h.realGuard = true;
    h.provider = { mailed: [], failOn: null, refuseBodiesOnce: true };
    const failed = await POST(makeReq());
    expect(failed.status).toBe(502);
    expect(h.guard.calls).toBe(0);
    expect(h.provider.mailed).toEqual([]);
    expect((await POST(makeReq())).status).toBe(409);
    expect(h.provider.mailed).toEqual([]);
    // Approving again is a new decision; nothing was sent, so everything is still to send.
    h.decisionId = "decision-2";
    expect((await POST(makeReq())).status).toBe(200);
    expect(h.provider.mailed).toEqual(RECIPIENTS);
  });

  it("a decision that is not released is refused with 403, not 409", async () => {
    h.realGuard = true;
    h.provider = { mailed: [], failOn: null };
    h.guard.status = "parked";
    const res = await POST(makeReq());
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("publish_not_released");
    expect(h.provider.mailed).toEqual([]);
  });
});

// The send's per-message record (cinatra#4787) keys each message by run, message identity and body revision, never by
// decision. Until that change is in this tree the send has none, and a new decision would mail recipient one again, so
// this case runs once the record is there (the send's use case calls `performRevisionEffectOnce` per message).
const SEND_RECORD_IN_TREE = readFileSync(new URL("../../../../../lib/trigger-email-send-use-cases.ts", import.meta.url), "utf8")
  .includes("performRevisionEffectOnce");

describe.runIf(SEND_RECORD_IN_TREE)("a re-approval after a partial send, through the send's per-message record", () => {
  it("mails recipient one once across three decisions; recipient two stays in doubt; recipient three goes out once", async () => {
    h.realGuard = true;
    h.provider = { mailed: [], failOn: RECIPIENTS[1]! };
    expect((await POST(makeReq())).status).toBe(502);
    expect(h.provider.mailed).toEqual([RECIPIENTS[0]]);
    expect((await POST(makeReq())).status).toBe(409);
    expect(h.provider.mailed).toEqual([RECIPIENTS[0]]);
    // A new approval is a new decision. Recipient one is skipped (sent), recipient two is not mailed (in doubt, for a
    // person to check), recipient three goes out; the call answers a failure with the counts.
    h.decisionId = "decision-2";
    h.provider.failOn = null;
    const second = await POST(makeReq());
    expect(second.status).toBe(502);
    expect(await second.json()).toMatchObject({ status: "failed", sentCount: 1, alreadySentCount: 1, inDoubtCount: 1 });
    expect(h.provider.mailed).toEqual([RECIPIENTS[0], RECIPIENTS[2]]);
    // And a third approval mails nobody again.
    h.decisionId = "decision-3";
    await POST(makeReq());
    expect(h.provider.mailed).toEqual([RECIPIENTS[0], RECIPIENTS[2]]);
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
  seamSlot.__cinatraArtifactReviewGateSeam = seamBefore;
  vi.doUnmock("../../../../../../packages/agents/src/publish-decision-store");
  vi.doUnmock("../../../../../../packages/agents/src/db");
  vi.doUnmock("server-only");
  vi.doUnmock("@cinatra-ai/agents");
  vi.doUnmock("@cinatra-ai/agents/store");
  vi.doUnmock("../../../../../../packages/agents/src/run-action-decision-consumption");
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
