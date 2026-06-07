/**
 * Tests for createInProcessA2AClient.
 *
 * Mocks @cinatra/agent-builder's readPublishedAgentTemplates / createAgentRun /
 * readAgentRunById so the client wiring can be exercised without Postgres.
 * The mocked readAgentRunById transitions status "queued" → "running" →
 * "completed" on successive calls, mirroring what a real worker would do.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@cinatra/agent-builder", () => ({
  readPublishedAgentTemplates: vi.fn(),
  createAgentRun: vi.fn(),
  readAgentRunById: vi.fn(),
  // These mocks must be present or agent-executor.ts throws "not a function"
  // before buildInitialTask seeds the task, causing the SDK to return -32603
  // "no task context found".
  readAgentTemplateById: vi.fn(),
  updateAgentRunA2ATaskId: vi.fn(),
}));

import {
  readPublishedAgentTemplates,
  createAgentRun,
  readAgentRunById,
  readAgentTemplateById,
  updateAgentRunA2ATaskId,
} from "@cinatra-ai/agents";
import { createInProcessA2AClient } from "../client";

const mockReadTemplates =
  readPublishedAgentTemplates as unknown as ReturnType<typeof vi.fn>;
const mockCreateRun = createAgentRun as unknown as ReturnType<typeof vi.fn>;
const mockReadRun = readAgentRunById as unknown as ReturnType<typeof vi.fn>;
const mockReadTemplateById =
  readAgentTemplateById as unknown as ReturnType<typeof vi.fn>;
const mockUpdateRunTaskId =
  updateAgentRunA2ATaskId as unknown as ReturnType<typeof vi.fn>;

function installDefaultMocks() {
  mockReadTemplates.mockResolvedValue([
    { id: "t-a", packageName: "pkg-a", name: "A" },
  ]);
  mockCreateRun.mockResolvedValue({ id: "run-a", status: "queued" });

  // Sequence: queued → running → completed (with stepResults)
  let call = 0;
  mockReadRun.mockImplementation(async () => {
    call += 1;
    if (call === 1) return { id: "run-a", status: "queued", stepResults: null };
    if (call === 2)
      return { id: "run-a", status: "running", stepResults: null };
    return {
      id: "run-a",
      status: "completed",
      stepResults: ["ok"],
      error: null,
    };
  });

  // Return null so the inputSchema validation branch is skipped entirely.
  mockReadTemplateById.mockResolvedValue(null);
  // Best-effort bridge write — always succeeds in tests.
  mockUpdateRunTaskId.mockResolvedValue(undefined);
}

describe("createInProcessA2AClient", () => {
  beforeEach(() => {
    mockReadTemplates.mockReset();
    mockCreateRun.mockReset();
    mockReadRun.mockReset();
    mockReadTemplateById.mockReset();
    mockUpdateRunTaskId.mockReset();
    installDefaultMocks();
  });

  it("returns a client exposing sendMessage, getTask, cancelTask, agentCard", async () => {
    const client = await createInProcessA2AClient({
      packageName: "pkg-a",
      enqueueJob: vi.fn().mockResolvedValue(undefined),
      pollIntervalMs: 5,
      pollTimeoutMs: 2_000,
    });

    expect(typeof client.sendMessage).toBe("function");
    expect(typeof client.getTask).toBe("function");
    expect(typeof client.cancelTask).toBe("function");
    expect(client.agentCard).toBeDefined();
  });

  it("sendMessage returns a Task whose terminal status.state is 'completed'", async () => {
    const client = await createInProcessA2AClient({
      packageName: "pkg-a",
      enqueueJob: vi.fn().mockResolvedValue(undefined),
      pollIntervalMs: 5,
      pollTimeoutMs: 2_000,
    });

    const task = await client.sendMessage({ text: "hello" });
    expect(typeof task.id).toBe("string");
    expect(task.id.length).toBeGreaterThan(0);
    expect(task.status.state).toBe("completed");
  }, 5_000);

  it("sendMessage calls enqueueJob exactly once with ('AGENT_BUILDER_EXECUTION', { runId })", async () => {
    const enqueueJob = vi.fn().mockResolvedValue(undefined);
    const client = await createInProcessA2AClient({
      packageName: "pkg-a",
      enqueueJob,
      pollIntervalMs: 5,
      pollTimeoutMs: 2_000,
    });

    await client.sendMessage({ text: "hello" });
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(enqueueJob).toHaveBeenCalledWith(
      "AGENT_BUILDER_EXECUTION",
      expect.objectContaining({ runId: expect.any(String) }),
    );
  }, 5_000);

  it("client.agentCard.name equals the requested packageName", async () => {
    const client = await createInProcessA2AClient({
      packageName: "pkg-a",
      enqueueJob: vi.fn().mockResolvedValue(undefined),
      pollIntervalMs: 5,
      pollTimeoutMs: 2_000,
    });
    expect(client.agentCard.name).toBe("pkg-a");
  });

  it("sendMessage serializes a json body into a text part (verified via createAgentRun input shape)", async () => {
    const client = await createInProcessA2AClient({
      packageName: "pkg-a",
      enqueueJob: vi.fn().mockResolvedValue(undefined),
      pollIntervalMs: 5,
      pollTimeoutMs: 2_000,
    });

    await client.sendMessage({ json: { prompt: "hi" } });
    expect(mockCreateRun).toHaveBeenCalledTimes(1);
    const call = mockCreateRun.mock.calls[0][0] as {
      inputParams: Record<string, unknown>;
    };
    // parseInputParams wraps pure JSON objects as inputParams directly.
    expect(call.inputParams).toEqual({ prompt: "hi" });
  }, 5_000);
});
