/**
 * cinatra#3745 — the passthrough road answers a refused run tool call with a
 * fixed 403 body.
 *
 * Three refusal classes end a run's tool call before or inside its tool: the
 * outward-action refusal (no current verified executing source, or a later
 * decision rule), the action-check refusal (arguments the host will not copy:
 * too deep, too many nodes) and the step-tool policy refusal (a tool the step
 * does not declare). Each is answered 403 with one fixed sentence and the
 * refusal's code; the body carries nothing else. Every other error keeps the
 * road's 500 answer unchanged: the fixed failure sentence (cinatra#4223), and
 * for an error with the zod marker, a refusal class included, the answer built
 * from its issues (cinatra#4465).
 *
 * Drives the real route, the real run binding and the real argument
 * preparation; the run store, the handler registry, the bridge-auth check,
 * the actor builder and the run-authority mint are test doubles.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

const h = vi.hoisted(() => {
  class RunStepToolPolicyRefusal extends Error {
    constructor(readonly code: string) { super(code); this.name = "RunStepToolPolicyRefusal"; }
  }
  return {
    RunStepToolPolicyRefusal,
    readAgentRunById: vi.fn(),
    readAgentRunByContextId: vi.fn(),
    verifyRunExecutedSource: vi.fn(),
    isRunExecutedSourceCurrent: vi.fn(),
    assertRunStepToolAllowed: vi.fn(),
    toolError: null as unknown,
    scoped: vi.fn(),
    observed: [] as string[],
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunById: h.readAgentRunById,
  readAgentRunByContextId: h.readAgentRunByContextId,
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  verifyRunExecutedSource: h.verifyRunExecutedSource,
  isRunExecutedSourceCurrent: h.isRunExecutedSourceCurrent,
  readRunStepToolPolicy: async () => ({ source: "bound-source-under-test" }),
  assertRunStepToolAllowed: h.assertRunStepToolAllowed,
  RunStepToolPolicyRefusal: h.RunStepToolPolicyRefusal,
}));
vi.mock("@/lib/org-write/run-authority-mint", () => ({
  mintRunWriteAuthorityForMcp: vi.fn(async () => undefined),
}));
vi.mock("@cinatra-ai/a2a", () => ({
  resolveLatestWayflowGateTaskId: vi.fn(async () => null),
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
vi.mock("@/lib/extension-scoped-tools", () => ({
  EXTENSION_SCOPED_TOOLS: new Set<string>(["extension_tool"]),
  dispatchExtensionScopedTool: (...args: unknown[]) => h.scoped(...args),
}));
vi.mock("@/lib/run-folder-tools", () => ({ RUN_FOLDER_TOOLS: new Set<string>() }));
vi.mock("@/lib/primitive-handlers", () => {
  const handler = (tool: string) => async () => {
    h.observed.push(tool);
    if (h.toolError) throw h.toolError;
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
import { ArtifactActionCheckRefusal, OutwardActionRefusal } from "@/lib/extension-host-context";
import { PASSTHROUGH_SCHEMA_ERROR, PASSTHROUGH_UNEXPECTED_ERROR } from "@/lib/passthrough-refusal";

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
const RUN_SCOPED_TOOL = "agent_run_hitl_prompts_list";
const FRAMELESS_TOOL = "trigger_config_set";
const SOURCE = {
  sourceSha256: "b".repeat(64),
  executedSourceSha256: "c".repeat(64),
  declarationSourceSha256: "d".repeat(64),
};
const VERIFIED_SOURCE = Object.freeze({ contextId: CTX, stepId: NODE, executionAttemptId: "attempt-1", ...SOURCE });
const SENTENCE = "The run's tool call was refused.";
const ATTEST_BEFORE = process.env.CINATRA_CONTEXT_ATTEST_KEY;

function sourceHeaders(): Record<string, string> {
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const sig = createHmac("sha256", ATTEST_KEY)
    .update(`s2\n${CTX}\n${NODE}\n${SOURCE.sourceSha256}\n${SOURCE.executedSourceSha256}\n${SOURCE.declarationSourceSha256}\n${expiry}`)
    .digest("hex");
  return {
    "x-cinatra-step-node": NODE,
    "x-cinatra-step-attestation": `s2:${expiry}:${sig}`,
    "x-cinatra-raw-source": SOURCE.sourceSha256,
    "x-cinatra-executed-source": SOURCE.executedSourceSha256,
    "x-cinatra-declaration-source": SOURCE.declarationSourceSha256,
  };
}

function makeReq(tool: string, headers: Record<string, string>, input: unknown = {}): Request {
  return new Request("http://localhost:3000/api/agents/passthrough", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cinatra-a2a-context-id": CTX, ...headers },
    body: JSON.stringify({ tool, input, agent_run_id: RUN.id }),
  });
}

/** An input nested `depth` objects deep. */
function nested(depth: number): Record<string, unknown> {
  let v: Record<string, unknown> = { leaf: true };
  for (let i = 0; i < depth; i++) v = { child: v };
  return v;
}

beforeEach(() => {
  h.observed.length = 0;
  h.toolError = null;
  h.scoped.mockReset();
  h.readAgentRunById.mockReset().mockResolvedValue(RUN);
  h.readAgentRunByContextId.mockReset().mockImplementation(async (ctx: string) => (ctx === CTX ? RUN : null));
  h.verifyRunExecutedSource.mockReset().mockResolvedValue(VERIFIED_SOURCE);
  h.isRunExecutedSourceCurrent.mockReset().mockResolvedValue(true);
  h.assertRunStepToolAllowed.mockReset().mockReturnValue({ kind: "undeclared" });
  process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_KEY;
});

afterEach(() => {
  if (ATTEST_BEFORE === undefined) delete process.env.CINATRA_CONTEXT_ATTEST_KEY;
  else process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_BEFORE;
});

describe("a refused run tool call is answered 403 with a fixed body", () => {
  // (m1)
  it("a call without a verified executing source", async () => {
    for (const tool of [RUN_SCOPED_TOOL, FRAMELESS_TOOL]) {
      h.observed.length = 0;
      const res = await POST(makeReq(tool, {}));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: SENTENCE, code: "action_executed_source_missing_or_stale" });
      expect(h.observed).toHaveLength(0);
    }
  });

  // (m2)
  it("a tool the step does not declare", async () => {
    h.assertRunStepToolAllowed.mockImplementation(() => {
      throw new h.RunStepToolPolicyRefusal("step_tool_not_declared");
    });
    const res = await POST(makeReq(RUN_SCOPED_TOOL, sourceHeaders()));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: SENTENCE, code: "step_tool_not_declared" });
    expect(h.observed).toHaveLength(0);
  });

  // (m3)
  it("arguments deeper than 32 levels or with more than 10,000 nodes", async () => {
    for (const input of [nested(40), { items: Array.from({ length: 10001 }, (_, i) => i) }]) {
      h.observed.length = 0;
      const res = await POST(makeReq(RUN_SCOPED_TOOL, sourceHeaders(), input));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: SENTENCE, code: "action_json_limit" });
      expect(h.observed).toHaveLength(0);
    }
  });

  // (m4)
  it("a refusal that the tool itself raises", async () => {
    for (const error of [
      new OutwardActionRefusal("outward_effect_requires_recorded_decision"),
      new ArtifactActionCheckRefusal("action_not_covered_by_pins"),
    ]) {
      h.toolError = error;
      const res = await POST(makeReq(FRAMELESS_TOOL, sourceHeaders()));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: SENTENCE, code: error.code });
    }
  });

  // (m6)
  it("an extension-scoped tool's refused outcome keeps its code", async () => {
    h.scoped.mockResolvedValue({ ok: false, status: 403, error: SENTENCE, code: "step_tool_not_declared" });
    const res = await POST(makeReq("extension_tool", sourceHeaders(), { name: "fixture_tool", input: {} }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: SENTENCE, code: "step_tool_not_declared" });
  });
});

describe("every other error keeps the generic answer", () => {
  // (m5)
  it("a tool error of another class is answered 500 with the fixed failure sentence, never its message", async () => {
    const lookalike = Object.assign(new Error("lookalike failure"), { name: "OutwardActionRefusal", code: "x" });
    for (const error of [new Error("tool failed: detail"), lookalike]) {
      h.toolError = error;
      const res = await POST(makeReq(FRAMELESS_TOOL, sourceHeaders()));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: PASSTHROUGH_UNEXPECTED_ERROR });
    }
  });

  // (m7)
  it("a refusal that carries the zod marker is answered from its issues, as any marked error (cinatra#4465)", async () => {
    const marked = Object.assign(new OutwardActionRefusal("outward_effect_requires_recorded_decision"), {
      _zod: { traits: new Set(["$ZodError"]) },
      issues: [{ path: ["name"], code: "invalid_type", expected: "string" }],
    });
    h.toolError = marked;
    const res = await POST(makeReq(FRAMELESS_TOOL, sourceHeaders()));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: `${PASSTHROUGH_SCHEMA_ERROR}: name: invalid_type, expected string` });
  });

  // (m8)
  it("a refusal whose zod marker cannot be read is answered 500 with the fixed failure sentence", async () => {
    // A traits value that is not a native Set: the native membership read throws.
    h.toolError = Object.assign(new ArtifactActionCheckRefusal("action_not_covered_by_pins"), { _zod: { traits: {} } });
    const res = await POST(makeReq(FRAMELESS_TOOL, sourceHeaders()));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: PASSTHROUGH_UNEXPECTED_ERROR });
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
