/**
 * cinatra#3745 — a run's tool call is prepared before any tool runs.
 *
 * (1) The proof that the run still runs under the frame's verified executing
 *     source and the step's policy are ONE read: a source that is no longer
 *     current when the policy is read refuses, and any failure of that read
 *     refuses with the fixed refusal (its class and code), never its text.
 * (2) The argument copy refuses what it cannot copy as plain JSON: an array
 *     whose prototype is not Array.prototype, a non-enumerable own property
 *     (data or accessor, on an object or an array) and a proxy; no getter runs.
 *     A null argument stays null; absent arguments are the empty object.
 *
 * The real preparation and copier run. The run store is a test double:
 * `readCurrentRunStepToolPolicy` is the one read the preparation makes; the two
 * older readers (`isRunExecutedSourceCurrent`, `readRunStepToolPolicy`) answer
 * the state BEFORE the race (current, policy readable), so a preparation that
 * still read them in two steps would serve the call.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mcpRequestContextStorage, type McpRequestContext } from "@cinatra-ai/mcp-server/request-context";

const h = vi.hoisted(() => {
  class RunStepToolPolicyRefusal extends Error {
    constructor(readonly code: string) { super(code); this.name = "RunStepToolPolicyRefusal"; }
  }
  return {
    RunStepToolPolicyRefusal,
    readCurrent: vi.fn(),
    olderCurrent: vi.fn(),
    olderPolicy: vi.fn(),
    assert: vi.fn(),
  };
});
vi.mock("@cinatra-ai/agents/store", () => ({
  readCurrentRunStepToolPolicy: (...a: unknown[]) => h.readCurrent(...a),
  isRunExecutedSourceCurrent: (...a: unknown[]) => h.olderCurrent(...a),
  readRunStepToolPolicy: (...a: unknown[]) => h.olderPolicy(...a),
  assertRunStepToolAllowed: (...a: unknown[]) => h.assert(...a),
  RunStepToolPolicyRefusal: h.RunStepToolPolicyRefusal,
}));
import {
  ArtifactActionCheckRefusal,
  immutableActionJson,
  OutwardActionRefusal,
  prepareDeclaredRunToolArguments,
  runActionRefusalClassCode,
} from "@/lib/extension-host-context";

const SOURCE = {
  contextId: "ctx-1", stepId: "step-1", executionAttemptId: "attempt-1",
  sourceSha256: "a".repeat(64), executedSourceSha256: "b".repeat(64), declarationSourceSha256: "c".repeat(64),
};
const POLICY = { source: "bound-source-under-test" };
const frame = (): McpRequestContext =>
  ({ orgId: "org-1", userId: "user-1", runId: "run-1", verifiedStepId: "step-1",
    verifiedExecutedSource: SOURCE }) as McpRequestContext;
const prepare = (args: unknown) =>
  mcpRequestContextStorage.run(frame(), () => prepareDeclaredRunToolArguments("objects_get", args));

beforeEach(() => {
  h.readCurrent.mockReset().mockResolvedValue(POLICY);
  h.olderCurrent.mockReset().mockResolvedValue(true);
  h.olderPolicy.mockReset().mockResolvedValue(POLICY);
  h.assert.mockReset().mockReturnValue({ kind: "undeclared" });
});

describe("the run source proof and the step policy are one read", () => {
  it("refuses a call whose source is no longer current when the policy is read, and checks no tool name", async () => {
    h.readCurrent.mockRejectedValue(new h.RunStepToolPolicyRefusal("step_tool_run_source_inactive"));
    const refused = await prepare({ id: "o-1" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(OutwardActionRefusal);
    expect((refused as OutwardActionRefusal).code).toBe("action_executed_source_missing_or_stale");
    expect(h.readCurrent).toHaveBeenCalledWith("run-1", "org-1", SOURCE);
    expect(h.assert).not.toHaveBeenCalled();
  });

  it("answers a store failure of that read with the fixed refusal, never the store's text", async () => {
    const raw = new Error('relation "secret_table" does not exist');
    h.readCurrent.mockRejectedValue(raw);
    h.olderPolicy.mockRejectedValue(raw);
    const refused = await prepare({ id: "o-1" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(OutwardActionRefusal);
    expect((refused as Error).message).toBe("action_executed_source_missing_or_stale");
  });
});

describe("the argument copy refuses what it cannot copy as plain JSON", () => {
  it("refuses an array whose prototype is not Array.prototype, even an empty one", () => {
    class Inputs extends Array {}
    expect(() => immutableActionJson(new Inputs())).toThrow("action_json_invalid");
    expect(() => immutableActionJson({ list: new Inputs() })).toThrow("action_json_invalid");
  });

  it("refuses a non-enumerable own property, data or accessor, and calls no getter", () => {
    const getter = vi.fn(() => "secret");
    const hiddenData = Object.defineProperty({ a: 1 }, "hidden", { value: undefined, enumerable: false });
    const hiddenAccessor = Object.defineProperty({ a: 1 }, "hidden", { get: getter, enumerable: false });
    const hiddenOnArray = Object.defineProperty([1], "hidden", { value: 2, enumerable: false });
    for (const value of [hiddenData, hiddenAccessor, hiddenOnArray]) {
      expect(() => immutableActionJson(value)).toThrow("action_json_invalid");
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("refuses a proxy before any of its traps runs", () => {
    const trap = vi.fn();
    const proxy = new Proxy({ a: 1 }, { ownKeys: (t) => { trap(); return Reflect.ownKeys(t); } });
    expect(() => immutableActionJson(proxy)).toThrow("action_json_invalid");
    expect(() => immutableActionJson([new Proxy([], {})])).toThrow("action_json_invalid");
    expect(trap).not.toHaveBeenCalled();
  });

  it("keeps a null argument null on a run frame; absent arguments are the empty object", async () => {
    expect(await prepare(null)).toBeNull();
    expect(await prepare(undefined)).toEqual({});
  });
});

// (3) The identity reading of the three refusal classes that the roads and the
//     in-process host invoker ask: the code of an instance of one of them, else null.
describe("the refusal classes of a run's tool call are read by identity", () => {
  it("answers the code of an instance of each of the three classes", () => {
    expect(runActionRefusalClassCode(new OutwardActionRefusal("action_executed_source_missing_or_stale")))
      .toBe("action_executed_source_missing_or_stale");
    expect(runActionRefusalClassCode(new ArtifactActionCheckRefusal("action_json_invalid"))).toBe("action_json_invalid");
    expect(runActionRefusalClassCode(new h.RunStepToolPolicyRefusal("step_tool_not_declared"))).toBe("step_tool_not_declared");
  });

  it("answers null for a lookalike, an ordinary error, a refusal without a code and a value that is no error", () => {
    expect(runActionRefusalClassCode(Object.assign(new Error("x"), { name: "OutwardActionRefusal", code: "x" }))).toBeNull();
    expect(runActionRefusalClassCode(new Error("step_tool_not_declared"))).toBeNull();
    expect(runActionRefusalClassCode(new OutwardActionRefusal(""))).toBeNull();
    expect(runActionRefusalClassCode("step_tool_not_declared")).toBeNull();
    expect(runActionRefusalClassCode(null)).toBeNull();
  });
});
