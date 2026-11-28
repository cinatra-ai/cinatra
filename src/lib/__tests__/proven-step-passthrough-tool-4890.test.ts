/**
 * cinatra#4890: the host tool the frame's proven step names, read in the run's
 * current bound source. The run store's policy read is a test double; the step
 * reader over the bound source is the real one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mcpRequestContextStorage, type McpRequestContext } from "@cinatra-ai/mcp-server/request-context";

const h = vi.hoisted(() => ({ readCurrent: vi.fn() }));
vi.mock("@cinatra-ai/agents/store", async () => ({
  readCurrentRunStepToolPolicy: (...a: unknown[]) => h.readCurrent(...a),
  findStepPassthroughTool: (await import("../../../packages/agents/src/validate-oas-runtime-invariants"))
    .findStepPassthroughTool,
}));
import * as host from "@/lib/extension-host-context";

type Reader = () => Promise<string | null | undefined>;
const read: Reader =
  (host as unknown as { readProvenStepPassthroughTool?: Reader }).readProvenStepPassthroughTool ??
  (async () => undefined);

const SOURCE = {
  contextId: "ctx-1", stepId: "stop", executionAttemptId: "attempt-1",
  sourceSha256: "a".repeat(64), executedSourceSha256: "b".repeat(64), declarationSourceSha256: "c".repeat(64),
};
const BOUND = JSON.stringify({
  component_type: "Flow", id: "flow", name: "flow",
  $referenced_components: {
    stop: { component_type: "ApiNode", id: "stop", name: "stop", http_method: "POST",
      url: "{{CINATRA_BASE_URL}}/api/agents/passthrough", data: { tool: "run_fail", input: {} } },
  },
});
const inFrame = (verifiedStepId: string) =>
  mcpRequestContextStorage.run(
    { orgId: "org-1", runId: "run-1", verifiedStepId, verifiedExecutedSource: SOURCE } as McpRequestContext,
    read,
  );

beforeEach(() => {
  h.readCurrent.mockReset().mockResolvedValue({ source: BOUND });
});

describe("readProvenStepPassthroughTool", () => {
  it("names the tool the proven step calls in the run's current bound source", async () => {
    expect(await inFrame("stop")).toBe("run_fail");
    expect(h.readCurrent).toHaveBeenCalledWith("run-1", "org-1", expect.objectContaining({ stepId: "stop" }));
  });

  it("names none when the frame's step is not the proof's, and reads nothing", async () => {
    expect(await inFrame("other")).toBe(null);
    expect(h.readCurrent).not.toHaveBeenCalled();
  });

  it("names none when the bound source is no longer current", async () => {
    h.readCurrent.mockRejectedValue(new Error("step_tool_run_source_inactive"));
    expect(await inFrame("stop")).toBe(null);
  });
});
