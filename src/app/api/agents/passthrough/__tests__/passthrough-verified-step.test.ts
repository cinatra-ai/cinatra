/**
 * cinatra#3745 — the deterministic passthrough road stamps the verified step
 * of the calling flow step on the frame it serves the call in.
 *
 * After the run binding proves the run from the context-id header, the runtime's
 * signed source-bound step pair is verified with that context id and the run's
 * bound flow source. Every tool the road serves runs inside the verified
 * executing-source frame, which carries `verifiedStepId`, and the run-scoped
 * frame a run-scoped tool gets carries it too. A call without a valid
 * source-bound pair is refused before any tool runs.
 *
 * Drives the real route and the real run binding; the run store, the handler
 * registry, the bridge-auth check, the actor builder and the run-authority
 * mint are test doubles.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

const h = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByContextId: vi.fn(),
  resolveLatestWayflowGateTaskId: vi.fn(async () => null as string | null),
  verifyRunExecutedSource: vi.fn(),
  assertRunStepToolAllowed: vi.fn(),
  mintRunWriteAuthorityForMcp: vi.fn(),
  policy: { source: "policy-under-test" },
  observed: [] as Array<{ tool: string; frame: unknown }>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunById: h.readAgentRunById,
  readAgentRunByContextId: h.readAgentRunByContextId,
}));
// The run store's source binding: the run's bound flow source and its step
// tool policy (the readers' own refusals are pinned in packages/agents).
vi.mock("@cinatra-ai/agents/store", () => ({
  verifyRunExecutedSource: h.verifyRunExecutedSource,
  isRunExecutedSourceCurrent: async () => true,
  readRunStepToolPolicy: async () => h.policy,
  assertRunStepToolAllowed: h.assertRunStepToolAllowed,
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
  const handler = (tool: string) => async () => {
    h.observed.push({ tool, frame: mcpRequestContextStorage.getStore() });
    return { ok: true };
  };
  return {
    collectAllPrimitiveHandlers: async () => ({
      agent_run_hitl_prompts_list: handler("agent_run_hitl_prompts_list"),
      trigger_config_set: handler("trigger_config_set"),
    }),
  };
});

import { POST } from "@/app/api/agents/passthrough/route";

const ATTEST_KEY = "step-attest-key-under-test";
const CTX = "ctx-run-1";
const NODE = "flow-step-node-1";
const SOURCE = {
  sourceSha256: "b".repeat(64),
  executedSourceSha256: "c".repeat(64),
  declarationSourceSha256: "d".repeat(64),
};
const VERIFIED_SOURCE = Object.freeze({
  contextId: CTX,
  stepId: NODE,
  executionAttemptId: "attempt-1",
  ...SOURCE,
});
const POLICY = h.policy;
const AUTHORITY = { authority: "run-authority-under-test" };
const RUN = {
  id: "run-1",
  orgId: "org-1",
  runBy: "user-1",
  templateId: "tpl-1",
  packageVersion: null,
  oboCeiling: null,
};
// A frameless tool and a run-scoped tool on the road's allowlist.
const FRAMELESS_TOOL = "trigger_config_set";
const RUN_SCOPED_TOOL = "agent_run_hitl_prompts_list";

const ATTEST_BEFORE = process.env.CINATRA_CONTEXT_ATTEST_KEY;

/** The step-only pair the runtime signed before its steps were source-bound. */
function stepHeaders(opts: { ctx?: string; node?: string; key?: string } = {}) {
  const ctx = opts.ctx ?? CTX;
  const node = opts.node ?? NODE;
  const key = opts.key ?? ATTEST_KEY;
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const sig = createHmac("sha256", key).update(`s1\n${ctx}\n${node}\n${expiry}`).digest("hex");
  return { "x-cinatra-step-node": node, "x-cinatra-step-attestation": `s1:${expiry}:${sig}` };
}

/** The source-bound pair the runtime signs over the executing flow source. */
function sourceHeaders(opts: { ctx?: string; node?: string; key?: string } = {}) {
  const ctx = opts.ctx ?? CTX;
  const node = opts.node ?? NODE;
  const key = opts.key ?? ATTEST_KEY;
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const { sourceSha256, executedSourceSha256, declarationSourceSha256 } = SOURCE;
  const sig = createHmac("sha256", key)
    .update(`s2\n${ctx}\n${node}\n${sourceSha256}\n${executedSourceSha256}\n${declarationSourceSha256}\n${expiry}`)
    .digest("hex");
  return {
    "x-cinatra-step-node": node,
    "x-cinatra-step-attestation": `s2:${expiry}:${sig}`,
    "x-cinatra-raw-source": sourceSha256,
    "x-cinatra-executed-source": executedSourceSha256,
    "x-cinatra-declaration-source": declarationSourceSha256,
  };
}

function makeReq(tool: string, headers: Record<string, string>): Request {
  return new Request("http://localhost:3000/api/agents/passthrough", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cinatra-a2a-context-id": CTX,
      ...headers,
    },
    body: JSON.stringify({ tool, input: {}, agent_run_id: RUN.id }),
  });
}

beforeEach(() => {
  h.observed.length = 0;
  h.readAgentRunById.mockReset().mockResolvedValue(RUN);
  h.readAgentRunByContextId.mockReset().mockImplementation(async (ctx: string) =>
    ctx === CTX ? RUN : null,
  );
  h.resolveLatestWayflowGateTaskId.mockReset().mockResolvedValue(null);
  h.verifyRunExecutedSource.mockReset().mockResolvedValue(VERIFIED_SOURCE);
  h.assertRunStepToolAllowed.mockReset().mockReturnValue(undefined);
  h.mintRunWriteAuthorityForMcp.mockReset().mockResolvedValue(AUTHORITY);
  process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_KEY;
});

afterEach(() => {
  if (ATTEST_BEFORE === undefined) delete process.env.CINATRA_CONTEXT_ATTEST_KEY;
  else process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_BEFORE;
});

describe("the passthrough road's verified step", () => {
  /** The verified executing-source frame every tool of the road is served in. */
  const SOURCE_FRAME = {
    runId: RUN.id,
    userId: RUN.runBy,
    orgId: RUN.orgId,
    verifiedStepId: NODE,
    verifiedExecutedSource: VERIFIED_SOURCE,
    orgWriteAuthority: AUTHORITY,
  };

  // (t1)
  it("a run-scoped tool called with a valid step pair sees the step on its frame", async () => {
    const res = await POST(makeReq(RUN_SCOPED_TOOL, sourceHeaders()));
    expect(res.status).toBe(200);
    expect(h.verifyRunExecutedSource).toHaveBeenCalledWith(RUN.id, RUN.orgId, {
      stepId: NODE,
      contextId: CTX,
      ...SOURCE,
    });
    expect(h.assertRunStepToolAllowed).toHaveBeenCalledWith({
      policy: POLICY,
      contextId: CTX,
      executedSourceSha256: SOURCE.executedSourceSha256,
      stepId: NODE,
      toolName: RUN_SCOPED_TOOL,
    });
    expect(h.mintRunWriteAuthorityForMcp).toHaveBeenCalledWith({
      runId: RUN.id,
      orgId: RUN.orgId,
      executionAttemptId: VERIFIED_SOURCE.executionAttemptId,
    });
    expect(h.observed).toHaveLength(1);
    const frame = h.observed[0]!.frame as Record<string, unknown>;
    expect(frame.verifiedRunScopeId).toBe(RUN.id);
    expect(frame.verifiedStepId).toBe(NODE);
    expect(frame).toEqual({ ...SOURCE_FRAME, verifiedRunScopeId: RUN.id });
  });

  // (t2)
  it("an invalid or absent pair is refused before any tool runs", async () => {
    const valid = sourceHeaders();
    const variants: Array<{ headers: Record<string, string>; status: number; error: string }> = [
      { headers: {}, status: 500, error: "action_executed_source_missing_or_stale" },
      { headers: stepHeaders(), status: 500, error: "action_executed_source_missing_or_stale" },
      { headers: sourceHeaders({ ctx: "ctx-run-2" }), status: 403, error: "Executing source could not be verified" },
      { headers: sourceHeaders({ key: "another-key-under-test" }), status: 403, error: "Executing source could not be verified" },
      { headers: { ...valid, "x-cinatra-step-node": "other-node" }, status: 403, error: "Executing source could not be verified" },
      { headers: { ...valid, "x-cinatra-executed-source": "e".repeat(64) }, status: 403, error: "Executing source could not be verified" },
      { headers: { "x-cinatra-step-node": NODE, "x-cinatra-step-id": NODE }, status: 500, error: "action_executed_source_missing_or_stale" },
    ];
    for (const { headers, status, error } of variants) {
      h.observed.length = 0;
      const res = await POST(makeReq(RUN_SCOPED_TOOL, headers));
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error });
      expect(h.observed).toHaveLength(0);
    }
    // A valid pair whose run is not bound to that source is refused the same way.
    h.observed.length = 0;
    h.verifyRunExecutedSource.mockRejectedValueOnce(new Error("step_tool_run_source_inactive"));
    const res = await POST(makeReq(RUN_SCOPED_TOOL, valid));
    expect(res.status).toBe(403);
    expect(h.observed).toHaveLength(0);
    expect(h.assertRunStepToolAllowed).not.toHaveBeenCalled();
  });

  // (t3)
  it("a tool served without a run-scoped frame runs in the verified source frame alone", async () => {
    const res = await POST(makeReq(FRAMELESS_TOOL, sourceHeaders()));
    expect(res.status).toBe(200);
    expect(h.observed).toHaveLength(1);
    expect(h.observed[0]!.tool).toBe(FRAMELESS_TOOL);
    expect(h.observed[0]!.frame).toEqual(SOURCE_FRAME);
    expect(h.assertRunStepToolAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ stepId: NODE, toolName: FRAMELESS_TOOL }),
    );
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
