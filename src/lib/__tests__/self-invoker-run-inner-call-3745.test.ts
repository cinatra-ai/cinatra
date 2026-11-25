/**
 * cinatra#3745 — the self-invoker (`ctx.mcp.callPrimitive`) on a run's frame.
 *
 * A run frame reaches the self-invoker only from inside a live request's tool
 * handler, whose own name the step's declaration already admitted. The nested
 * call is that tool's inner call: its run source is still proven and its input
 * is the frozen copy, but its own name is not checked against the step's tool
 * offer. A refusal keeps its class and code (not a plain boundary error), so the
 * extension-scoped road answers it with the fixed 403.
 *
 * The real self-invoker, the real preparation and the real refusal map run. The
 * host primitive map, the MCP boundary and the run store are test doubles; the
 * store's step check refuses every name, so only a call that skips it is served.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mcpRequestContextStorage, type McpRequestContext } from "@cinatra-ai/mcp-server";

const h = vi.hoisted(() => {
  class RunStepToolPolicyRefusal extends Error {
    constructor(readonly code: string) { super(code); this.name = "RunStepToolPolicyRefusal"; }
  }
  return {
    RunStepToolPolicyRefusal,
    handled: [] as unknown[],
    readCurrent: vi.fn(),
    olderCurrent: vi.fn(),
    assert: vi.fn(),
  };
});
vi.mock("@/lib/mcp-server", () => ({
  buildHostSelfPrimitiveHandlers: async () => new Map([["objects_get", {
    handler: async (input: unknown) => { h.handled.push(input); return { structuredContent: { ok: true } }; },
    planned: { name: "objects_get", registeredName: "objects_get", declaredOutward: null },
  }]]),
}));
vi.mock("@/lib/authz/mcp-boundary", () => ({ enforceMcpBoundary: async () => ({ allowed: true }) }));
vi.mock("@cinatra-ai/agents/store", () => ({
  readCurrentRunStepToolPolicy: (...a: unknown[]) => h.readCurrent(...a),
  // The older two-step readers answer as the store did before the call went stale.
  isRunExecutedSourceCurrent: (...a: unknown[]) => h.olderCurrent(...a),
  readRunStepToolPolicy: async () => ({ source: "bound-source-under-test" }),
  assertRunStepToolAllowed: (...a: unknown[]) => h.assert(...a),
  RunStepToolPolicyRefusal: h.RunStepToolPolicyRefusal,
}));
import { callHostPrimitive, __resetHostSelfPrimitiveHandlers } from "@/lib/extension-self-mcp";
import type * as RunActionRefusal from "@/lib/run-action-refusal";
let runActionRefusalCode!: typeof RunActionRefusal.runActionRefusalCode;
async function loadRunActionRefusal(): Promise<void> {
  ({ runActionRefusalCode } = await import("@/lib/run-action-refusal"));
}

const SOURCE = {
  contextId: "ctx-1", stepId: "step-1", executionAttemptId: "attempt-1",
  sourceSha256: "a".repeat(64), executedSourceSha256: "b".repeat(64), declarationSourceSha256: "c".repeat(64),
};
const runFrame = (): McpRequestContext =>
  ({ orgId: "org-1", userId: "user-1", runId: "run-1", verifiedStepId: "step-1",
    verifiedExecutedSource: SOURCE }) as McpRequestContext;
const callNested = () =>
  mcpRequestContextStorage.run(runFrame(), () => callHostPrimitive("objects_get", { id: "o-1" }));

beforeEach(() => {
  __resetHostSelfPrimitiveHandlers();
  h.handled.length = 0;
  h.readCurrent.mockReset().mockResolvedValue({ source: "bound-source-under-test" });
  h.olderCurrent.mockReset().mockResolvedValue(true);
  h.assert.mockReset().mockImplementation(() => { throw new h.RunStepToolPolicyRefusal("step_tool_not_declared"); });
});
afterAll(() => {
  __resetHostSelfPrimitiveHandlers();
  vi.doUnmock("@/lib/mcp-server");
  vi.doUnmock("@/lib/authz/mcp-boundary");
  vi.doUnmock("@cinatra-ai/agents/store");
  vi.resetModules();
});

describe("the self-invoker's call on a run frame is the admitted tool's inner call", () => {
  it("proves the run source and serves the frozen input without checking its own name against the step's offer", async () => {
    await loadRunActionRefusal();
    expect(await callNested()).toEqual({ ok: true });
    expect(h.readCurrent).toHaveBeenCalledWith("run-1", "org-1", SOURCE);
    expect(h.assert).not.toHaveBeenCalled();
    expect(h.handled).toHaveLength(1);
    expect(h.handled[0]).toEqual({ id: "o-1" });
    expect(Object.isFrozen(h.handled[0])).toBe(true);
  });

  it("refuses a stale source with its refusal class and code, which the run-call refusal map reads", async () => {
    await loadRunActionRefusal();
    h.readCurrent.mockRejectedValue(new h.RunStepToolPolicyRefusal("step_tool_run_source_inactive"));
    h.olderCurrent.mockResolvedValue(false);
    const refused = await callNested().catch((e: unknown) => e);
    expect(await runActionRefusalCode(refused)).toBe("action_executed_source_missing_or_stale");
    expect(h.handled).toHaveLength(0);
  });
});
