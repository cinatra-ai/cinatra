/**
 * cinatra#3745 (criterion 5b) — the deterministic passthrough keeps the
 * person-decision road of `email_test_delivery_run_send`.
 *
 * The send tool is in the outward-effect set, and it evaluates the person's
 * answered gate itself: it sends only for the verified submission the host
 * reads from its own latest-gate-task record and stamps on the run-scoped
 * frame, and its ledger uses that submission once. With that verified
 * submission the route serves it behind every other boundary ceiling. Without
 * one (no record, or a read error), or with only a caller-supplied id, the full
 * boundary refuses it for want of the person's recorded decision.
 *
 * Drives the real route, the real run binding and the real boundary; the run
 * store, the handler registry (the send handler records the frame it is served
 * in), the bridge-auth check, the actor builder and the run-authority mint are
 * test doubles. The handler's own ledger is pinned in packages/agents
 * (test-delivery-resume-idempotency.integration.test.ts).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

const h = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByContextId: vi.fn(),
  resolveLatestWayflowGateTaskId: vi.fn(async () => null as string | null),
  verifyRunExecutedSource: vi.fn(),
  mintRunWriteAuthorityForMcp: vi.fn(),
  sends: [] as Array<{ input: unknown; frame: Record<string, unknown> }>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunById: h.readAgentRunById,
  readAgentRunByContextId: h.readAgentRunByContextId,
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  verifyRunExecutedSource: h.verifyRunExecutedSource,
  isRunExecutedSourceCurrent: async () => true,
  readRunStepToolPolicy: async () => ({}),
  assertRunStepToolAllowed: () => undefined,
}));
vi.mock("@/lib/org-write/run-authority-mint", () => ({
  mintRunWriteAuthorityForMcp: h.mintRunWriteAuthorityForMcp,
}));
vi.mock("@cinatra-ai/a2a", () => ({
  resolveLatestWayflowGateTaskId: h.resolveLatestWayflowGateTaskId,
}));
vi.mock("@cinatra-ai/mcp-server", async () => {
  const actual = await vi.importActual<typeof import("@cinatra-ai/mcp-server/request-context")>(
    "@cinatra-ai/mcp-server/request-context",
  );
  return { mcpRequestContextStorage: actual.mcpRequestContextStorage };
});
vi.mock("@cinatra-ai/llm/actor-context", () => ({
  withActorContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/wayflow-bridge-auth", () => ({
  isAuthorizedBridgeRequest: () => true,
}));
vi.mock("@/lib/authz/build-actor-context-from-run", () => ({
  buildActorContextFromRun: vi.fn(async () => ({
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: "org-1",
    platformRole: "member",
  })),
}));
vi.mock("@/lib/extension-scoped-tools", () => ({ EXTENSION_SCOPED_TOOLS: new Set<string>() }));
vi.mock("@/lib/run-folder-tools", () => ({ RUN_FOLDER_TOOLS: new Set<string>() }));
vi.mock("@/lib/primitive-handlers", async () => {
  const { mcpRequestContextStorage } = await vi.importActual<
    typeof import("@cinatra-ai/mcp-server/request-context")
  >("@cinatra-ai/mcp-server/request-context");
  return {
    collectAllPrimitiveHandlers: async () => ({
      email_test_delivery_run_send: async (call: { input: unknown }) => {
        h.sends.push({ input: call.input, frame: { ...mcpRequestContextStorage.getStore() } as Record<string, unknown> });
        return { sent: 1 };
      },
    }),
  };
});

import { POST } from "@/app/api/agents/passthrough/route";
import {
  OUTWARD_EFFECT_TOOL_NAMES,
  PERSON_DECISION_EVALUATING_TOOLS,
  RECORDED_DECISION_REQUIRED_REASON,
} from "@/lib/authz/mcp-boundary";

const SEND = "email_test_delivery_run_send";
const ATTEST_KEY = "step-attest-key-under-test";
const CTX = "ctx-run-1";
const NODE = "flow-step-node-1";
const SOURCE = {
  sourceSha256: "b".repeat(64),
  executedSourceSha256: "c".repeat(64),
  declarationSourceSha256: "d".repeat(64),
};
const VERIFIED_SOURCE = Object.freeze({ contextId: CTX, stepId: NODE, executionAttemptId: "attempt-1", ...SOURCE });
const RUN = { id: "run-1", orgId: "org-1", runBy: "user-1", templateId: "tpl-1", packageVersion: null, oboCeiling: null };
const ATTEST_BEFORE = process.env.CINATRA_CONTEXT_ATTEST_KEY;

/** The source-bound pair the runtime signs over the executing flow source. */
function sourceHeaders() {
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const { sourceSha256, executedSourceSha256, declarationSourceSha256 } = SOURCE;
  const sig = createHmac("sha256", ATTEST_KEY)
    .update(`s2\n${CTX}\n${NODE}\n${sourceSha256}\n${executedSourceSha256}\n${declarationSourceSha256}\n${expiry}`)
    .digest("hex");
  return {
    "x-cinatra-step-node": NODE,
    "x-cinatra-step-attestation": `s2:${expiry}:${sig}`,
    "x-cinatra-raw-source": sourceSha256,
    "x-cinatra-executed-source": executedSourceSha256,
    "x-cinatra-declaration-source": declarationSourceSha256,
  };
}

function sendReq(body: Record<string, unknown> = {}): Request {
  return new Request("http://localhost:3000/api/agents/passthrough", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cinatra-a2a-context-id": CTX, ...sourceHeaders() },
    body: JSON.stringify({ tool: SEND, input: { recipientEmail: "qa@example.test" }, agent_run_id: RUN.id, ...body }),
  });
}

beforeEach(() => {
  h.sends.length = 0;
  h.readAgentRunById.mockReset().mockResolvedValue(RUN);
  h.readAgentRunByContextId.mockReset().mockImplementation(async (ctx: string) => (ctx === CTX ? RUN : null));
  h.resolveLatestWayflowGateTaskId.mockReset().mockResolvedValue(null);
  h.verifyRunExecutedSource.mockReset().mockResolvedValue(VERIFIED_SOURCE);
  h.mintRunWriteAuthorityForMcp.mockReset().mockResolvedValue({ authority: "run-authority-under-test" });
  process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_KEY;
});

afterEach(() => {
  if (ATTEST_BEFORE === undefined) delete process.env.CINATRA_CONTEXT_ATTEST_KEY;
  else process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_BEFORE;
});

describe("the passthrough's person-decision send road (cinatra#3745, 5b)", () => {
  it("serves the send once, on the verified submission the host read for the run", async () => {
    h.resolveLatestWayflowGateTaskId.mockResolvedValue("gate-task-1");
    const res = await POST(sendReq());
    expect(res.status).toBe(200);
    expect(h.resolveLatestWayflowGateTaskId).toHaveBeenCalledWith(RUN.id);
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.frame).toMatchObject({
      runId: RUN.id, verifiedRunScopeId: RUN.id, verifiedSubmissionId: "gate-task-1",
      verifiedStepId: NODE, orgId: RUN.orgId, userId: RUN.runBy,
    });
  });

  it("refuses the send with no verified submission (no latest gate task)", async () => {
    const res = await POST(sendReq());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: RECORDED_DECISION_REQUIRED_REASON });
    expect(h.sends).toHaveLength(0);
  });

  it("refuses the send when the latest-gate-task read fails", async () => {
    h.resolveLatestWayflowGateTaskId.mockRejectedValue(new Error("redis unavailable"));
    const res = await POST(sendReq());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: RECORDED_DECISION_REQUIRED_REASON });
    expect(h.sends).toHaveLength(0);
  });

  it("ignores a submission id the caller supplies in the body or the input", async () => {
    const forged = { verifiedSubmissionId: "forged-task" };
    const res = await POST(sendReq({ ...forged, input: { recipientEmail: "qa@example.test", ...forged } }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: RECORDED_DECISION_REQUIRED_REASON });
    expect(h.sends).toHaveLength(0);

    // With the host's own read, the frame carries the host's id, never the caller's.
    h.resolveLatestWayflowGateTaskId.mockResolvedValue("gate-task-1");
    const served = await POST(sendReq({ ...forged, input: { recipientEmail: "qa@example.test", ...forged } }));
    expect(served.status).toBe(200);
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.frame.verifiedSubmissionId).toBe("gate-task-1");
  });

  it("census: exactly the one send tool evaluates the person's decision, and it is an outward tool", () => {
    expect([...PERSON_DECISION_EVALUATING_TOOLS]).toEqual([SEND]);
    for (const tool of PERSON_DECISION_EVALUATING_TOOLS) expect(OUTWARD_EFFECT_TOOL_NAMES.has(tool)).toBe(true);
  });
});

// Leave the module registry as this file found it.
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
  vi.resetModules();
});
