/**
 * cinatra#3745 — the deterministic passthrough road stamps the verified step
 * of the calling flow step on the run-scoped frame it opens.
 *
 * After the run binding proves the run from the context-id header, the runtime's
 * signed step pair is verified with that context id, and the frame the road
 * opens for a run-scoped tool carries `verifiedStepId`. A tool the road serves
 * without a frame keeps that path. A call without source headers and without a
 * valid `s1` pair is served exactly as before and carries no step.
 *
 * A call with any source header must carry a source-bound `s2` pair that
 * verifies over the step, the execution attempt its task was sent under and the
 * three source digests, and the run store must prove the run is bound to that
 * source under that attempt, its running one; the step is
 * then the proof's. Otherwise the call is refused with a fixed 403 sentence
 * before any tool runs.
 *
 * Drives the real route and the real run binding; the run store (with its
 * source check), the handler registry, the bridge-auth check and the actor
 * builder are test doubles.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

const h = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByContextId: vi.fn(),
  resolveLatestWayflowGateTaskId: vi.fn(async () => null as string | null),
  verifyRunExecutedSource: vi.fn(),
  observed: [] as Array<{ tool: string; frame: unknown }>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/agents", () => ({
  publishCallAllowed: async () => true, // cinatra#4150: no publish decision holds this run
  readAgentRunById: h.readAgentRunById,
  readAgentRunByContextId: h.readAgentRunByContextId,
}));
// The run store's source check (its own refusals are pinned in packages/agents).
vi.mock("@cinatra-ai/agents/store", () => ({
  verifyRunExecutedSource: h.verifyRunExecutedSource,
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
const SOURCE = {
  sourceSha256: "b".repeat(64),
  executedSourceSha256: "c".repeat(64),
  declarationSourceSha256: "d".repeat(64),
};
const ATTEMPT = "attempt-1";
const VERIFIED_SOURCE = Object.freeze({ contextId: CTX, stepId: NODE, executionAttemptId: ATTEMPT, ...SOURCE });
const REFUSED = { error: "Executing source could not be verified" };

/** The source-bound pair the runtime signs over the step, its task's attempt and the executing source. */
function sourceHeaders(opts: { ctx?: string; node?: string; key?: string; source?: typeof SOURCE; attempt?: string } = {}) {
  const ctx = opts.ctx ?? CTX;
  const node = opts.node ?? NODE;
  const key = opts.key ?? ATTEST_KEY;
  const attempt = opts.attempt ?? ATTEMPT;
  const { sourceSha256, executedSourceSha256, declarationSourceSha256 } = opts.source ?? SOURCE;
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const sig = createHmac("sha256", key)
    .update(`s2\n${ctx}\n${node}\n${attempt}\n${sourceSha256}\n${executedSourceSha256}\n${declarationSourceSha256}\n${expiry}`)
    .digest("hex");
  return {
    "x-cinatra-step-node": node,
    "x-cinatra-execution-attempt": attempt,
    "x-cinatra-step-attestation": `s2:${expiry}:${sig}`,
    "x-cinatra-raw-source": sourceSha256,
    "x-cinatra-executed-source": executedSourceSha256,
    "x-cinatra-declaration-source": declarationSourceSha256,
  };
}

function stepHeaders(opts: { ctx?: string; node?: string; key?: string } = {}) {
  const ctx = opts.ctx ?? CTX;
  const node = opts.node ?? NODE;
  const key = opts.key ?? ATTEST_KEY;
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const sig = createHmac("sha256", key).update(`s1\n${ctx}\n${node}\n${expiry}`).digest("hex");
  return { "x-cinatra-step-node": node, "x-cinatra-step-attestation": `s1:${expiry}:${sig}` };
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
  process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_KEY;
});

afterEach(() => {
  if (ATTEST_BEFORE === undefined) delete process.env.CINATRA_CONTEXT_ATTEST_KEY;
  else process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_BEFORE;
});

describe("the passthrough road's verified step", () => {
  // (t1)
  it("a run-scoped tool called with a valid step pair sees the step on its frame", async () => {
    const res = await POST(makeReq(RUN_SCOPED_TOOL, stepHeaders()));
    expect(res.status).toBe(200);
    expect(h.observed).toHaveLength(1);
    const frame = h.observed[0]!.frame as Record<string, unknown>;
    expect(frame.verifiedRunScopeId).toBe(RUN.id);
    expect(frame.verifiedStepId).toBe(NODE);
  });

  // (t2)
  it("an invalid or absent pair leaves the run-scoped frame as before, with no step", async () => {
    const valid = stepHeaders();
    const variants: Array<Record<string, string>> = [
      {},
      stepHeaders({ ctx: "ctx-run-2" }),
      stepHeaders({ key: "another-key-under-test" }),
      { ...valid, "x-cinatra-step-node": "other-node" },
      { "x-cinatra-step-node": NODE, "x-cinatra-step-id": NODE },
    ];
    for (const headers of variants) {
      h.observed.length = 0;
      const res = await POST(makeReq(RUN_SCOPED_TOOL, headers));
      expect(res.status).toBe(200);
      expect(h.observed).toHaveLength(1);
      const frame = h.observed[0]!.frame as Record<string, unknown>;
      expect(frame).toEqual({
        runId: RUN.id,
        verifiedRunScopeId: RUN.id,
        userId: RUN.runBy,
        orgId: RUN.orgId,
      });
    }
  });

  // (t3)
  it("a tool served without a frame is invoked as before and no frame is opened", async () => {
    const res = await POST(makeReq(FRAMELESS_TOOL, stepHeaders()));
    expect(res.status).toBe(200);
    expect(h.observed).toHaveLength(1);
    expect(h.observed[0]!.tool).toBe(FRAMELESS_TOOL);
    expect(h.observed[0]!.frame).toBeUndefined();
  });
});

describe("the passthrough road's source-bound step", () => {
  // (t4)
  it("a valid source-bound pair on a bound run is served, and the step is the run store's proof", async () => {
    const res = await POST(makeReq(RUN_SCOPED_TOOL, sourceHeaders()));
    expect(res.status).toBe(200);
    expect(h.verifyRunExecutedSource).toHaveBeenCalledTimes(1);
    expect(h.verifyRunExecutedSource).toHaveBeenCalledWith(RUN.id, RUN.orgId,
      { stepId: NODE, contextId: CTX, executionAttemptId: ATTEMPT, ...SOURCE });
    expect(h.observed).toHaveLength(1);
    const frame = h.observed[0]!.frame as Record<string, unknown>;
    expect(frame).toEqual({ runId: RUN.id, verifiedRunScopeId: RUN.id, userId: RUN.runBy, orgId: RUN.orgId,
      verifiedStepId: NODE });
  });

  // (t5)
  it("a source header with a pair that does not verify is refused before any tool runs", async () => {
    const valid = sourceHeaders();
    const variants: Array<Record<string, string>> = [
      sourceHeaders({ ctx: "ctx-run-2" }),
      sourceHeaders({ key: "another-key-under-test" }),
      { ...valid, "x-cinatra-step-node": "other-node" },
      { ...valid, "x-cinatra-executed-source": "e".repeat(64) },
      // Attempt A's pair presented as attempt B's, B's pair presented as A's, and no attempt.
      { ...valid, "x-cinatra-execution-attempt": "attempt-2" },
      { ...sourceHeaders({ attempt: "attempt-2" }), "x-cinatra-execution-attempt": ATTEMPT },
      (() => { const { "x-cinatra-execution-attempt": _a, ...rest } = valid; void _a; return rest; })(),
      { ...valid, "x-cinatra-step-attestation": stepHeaders()["x-cinatra-step-attestation"] },
      { ...stepHeaders(), "x-cinatra-raw-source": SOURCE.sourceSha256 },
      { "x-cinatra-declaration-source": SOURCE.declarationSourceSha256 },
    ];
    for (const headers of variants) {
      h.observed.length = 0;
      const res = await POST(makeReq(RUN_SCOPED_TOOL, headers));
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(await res.json()).toEqual(REFUSED);
      expect(h.observed).toHaveLength(0);
    }
    expect(h.verifyRunExecutedSource).not.toHaveBeenCalled();
  });

  // (t6)
  it("a valid pair whose run is not bound to that source under its running attempt is refused the same way", async () => {
    for (const code of ["step_tool_run_source_inactive", "step_tool_executed_source_mismatch", "step_tool_binding_missing"]) {
      for (const tool of [RUN_SCOPED_TOOL, FRAMELESS_TOOL]) {
        h.observed.length = 0;
        h.verifyRunExecutedSource.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
        const res = await POST(makeReq(tool, sourceHeaders()));
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body).toEqual(REFUSED);
        expect(JSON.stringify(body)).not.toContain(code);
        expect(h.observed).toHaveLength(0);
      }
    }
  });

  // (t7)
  it("a valid pair on a run the store cannot read is refused", async () => {
    h.readAgentRunById.mockReset().mockResolvedValueOnce(null).mockResolvedValue(RUN);
    const res = await POST(makeReq(RUN_SCOPED_TOOL, sourceHeaders()));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(REFUSED);
    expect(h.verifyRunExecutedSource).not.toHaveBeenCalled();
    expect(h.observed).toHaveLength(0);
  });

  // (t8)
  it("a call without source headers takes the s1 road and never reads the source check", async () => {
    const res = await POST(makeReq(RUN_SCOPED_TOOL, stepHeaders()));
    expect(res.status).toBe(200);
    expect((h.observed[0]!.frame as Record<string, unknown>).verifiedStepId).toBe(NODE);
    expect(h.verifyRunExecutedSource).not.toHaveBeenCalled();
  });
});

// Leave the module registry as this file found it.
afterAll(() => {
  vi.doUnmock("server-only");
  vi.doUnmock("@cinatra-ai/agents");
  vi.doUnmock("@cinatra-ai/agents/store");
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
