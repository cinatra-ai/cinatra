/**
 * cinatra#4762 — the attempt a produced event belongs to comes from the attempt itself (the frame the write runs in),
 * never from a read of the run row when the writer runs.
 */
import { describe, expect, it } from "vitest";
import { mcpRequestContextStorage, type McpRequestContext } from "@cinatra-ai/mcp-server/request-context";

type AttemptOf = (runId: string | null | undefined) => unknown;
const load = async (): Promise<AttemptOf> =>
  import("../lifecycle-emit").then((m) => ((m as { producerAttemptForRun?: AttemptOf }).producerAttemptForRun ?? (() => null)));
const inFrame = <T>(frame: McpRequestContext, fn: () => T): T => mcpRequestContextStorage.run(frame, fn);

describe("producerAttemptForRun", () => {
  // red-first-expect: expected null to deeply equal { generation: +0 }
  it("the run worker's frame names the generation it captured when the attempt started, for its own run only", async () => {
    const attemptOf = await load();
    const frame = { runAttempt: { runId: "run-a", resetGeneration: 0 } } as McpRequestContext;
    expect(inFrame(frame, () => attemptOf("run-a"))).toEqual({ generation: 0 });
    // Another run in the same frame has no attempt identity here.
    expect(inFrame(frame, () => attemptOf("run-b"))).toBeNull();
    // The carried generation wins over a verified dispatch of the same run.
    const both = { ...frame, runId: "run-a", verifiedExecutedSource: { executionAttemptId: "att-1" } } as McpRequestContext;
    expect(inFrame(both, () => attemptOf("run-a"))).toEqual({ generation: 0 });
  });

  // red-first-expect: expected null to deeply equal { executionAttemptId: 'att-1' }
  it("a verified dispatch of the run names its attempt id: the run-bound seam's executing source, or the agent-run token's claim", async () => {
    const attemptOf = await load();
    const seam = { runId: "run-a", verifiedExecutedSource: { executionAttemptId: "att-1" } } as McpRequestContext;
    expect(inFrame(seam, () => attemptOf("run-a"))).toEqual({ executionAttemptId: "att-1" });
    expect(inFrame(seam, () => attemptOf("run-b"))).toBeNull();
    const token = { delegatedActor: { delegation: "agent_run", runId: "run-a", executionAttemptId: "att-2" } } as McpRequestContext;
    expect(inFrame(token, () => attemptOf("run-a"))).toEqual({ executionAttemptId: "att-2" });
    expect(inFrame(token, () => attemptOf("run-b"))).toBeNull();
  });

  it("no frame, no run, or a frame with no attempt of the run: no attempt identity", async () => {
    const attemptOf = await load();
    expect(attemptOf("run-a")).toBeNull();
    expect(inFrame({ runAttempt: { runId: "run-a", resetGeneration: 0 } } as McpRequestContext, () => attemptOf(null))).toBeNull();
    expect(inFrame({ runId: "run-a" } as McpRequestContext, () => attemptOf("run-a"))).toBeNull();
    const tokenless = { delegatedActor: { delegation: "agent_run", runId: "run-a" } } as McpRequestContext;
    expect(inFrame(tokenless, () => attemptOf("run-a"))).toBeNull();
  });
});
