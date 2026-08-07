/**
 * cinatra#2486 — a terminal FAILED run must carry its reason across the A2A
 * boundary.
 *
 * The poll-observed terminal update previously wrote only `{state, timestamp}`
 * for a failure, so a remote A2A consumer saw "failed" with no diagnostic while
 * the host UI showed the reason from `agent_runs.error`. That gap became
 * load-bearing once an artifact-materialization failure started landing the run
 * `failed` instead of reporting a clean `completed` with the failure buried in
 * stepResults: without the status message, the evidence would be invisible to
 * every external caller.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { readAgentRunByIdMock } = vi.hoisted(() => ({
  readAgentRunByIdMock: vi.fn(),
}));

vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunById: readAgentRunByIdMock,
  updateAgentRunA2ATaskId: vi.fn(async () => undefined),
  readAgentTemplateById: vi.fn(async () => null),
  jsonSchemaToZod: vi.fn(() => ({ parse: vi.fn() })),
}));
vi.mock("@cinatra-ai/llm/actor-context", () => ({
  getActorContext: vi.fn(() => null),
}));
vi.mock("../streaming-bridge", () => ({
  publishRunEvent: vi.fn(async () => undefined),
}));

import { InProcessAgentExecutor } from "../agent-executor";

type StoredTask = {
  id: string;
  status: { state: string; timestamp: string; message?: unknown };
  artifacts?: unknown[];
};

function makeTaskStore(task: StoredTask) {
  return {
    load: vi.fn(async () => task),
    save: vi.fn(async (t: StoredTask) => {
      Object.assign(task, t);
    }),
  };
}

function makeExecutor(taskStore: unknown) {
  return new InProcessAgentExecutor({
    taskStore,
    createRunWithAuthority: vi.fn(),
    enqueueJob: vi.fn(),
  } as never);
}

const requestContext = {
  taskId: "task-1",
  contextId: "ctx-1",
  userMessage: { kind: "message", role: "user", messageId: "m-1", parts: [] },
} as never;

/** Drive the private poll loop directly — it is the only path that observes a
 *  terminal DB state and writes it back onto the stored task. */
async function poll(executor: unknown, aborter: AbortController) {
  await (
    executor as {
      _backgroundPoll: (
        rc: unknown,
        runId: string,
        pollIntervalMs: number,
        pollTimeoutMs: number,
        aborter: AbortController,
      ) => Promise<void>;
    }
  )._backgroundPoll(requestContext, "run-1", 1, 5_000, aborter);
}

describe("cinatra#2486 — failed A2A tasks carry the run's error", () => {
  beforeEach(() => vi.clearAllMocks());

  it("attaches agent_runs.error as the failed task's agent status message", async () => {
    const task: StoredTask = {
      id: "task-1",
      status: { state: "working", timestamp: "t0" },
    };
    const store = makeTaskStore(task);
    readAgentRunByIdMock.mockResolvedValue({
      id: "run-1",
      status: "failed",
      error:
        'artifact materialization failed — the run declared artifact output(s) it did not produce (1 of 1 failed): draft: contentFrom output "content" did not resolve to a string',
      stepResults: [{ kind: "wayflow_response" }],
    });

    await poll(makeExecutor(store), new AbortController());

    expect(task.status.state).toBe("failed");
    const message = task.status.message as
      | { role?: string; parts?: Array<{ kind?: string; text?: string }> }
      | undefined;
    expect(message).toBeDefined();
    expect(message?.role).toBe("agent");
    expect(message?.parts?.[0]?.text).toContain("artifact materialization failed");
    // A failure is not a success: no stepResults artifact is attached.
    expect(task.artifacts).toBeUndefined();
  });

  it("leaves a failed task with no recorded error message-free (no invented text)", async () => {
    const task: StoredTask = {
      id: "task-1",
      status: { state: "working", timestamp: "t0" },
    };
    const store = makeTaskStore(task);
    readAgentRunByIdMock.mockResolvedValue({
      id: "run-1",
      status: "failed",
      error: null,
      stepResults: null,
    });

    await poll(makeExecutor(store), new AbortController());

    expect(task.status.state).toBe("failed");
    expect(task.status.message).toBeUndefined();
  });

  it("a completed run still attaches its stepResults artifact and no status message", async () => {
    const task: StoredTask = {
      id: "task-1",
      status: { state: "working", timestamp: "t0" },
    };
    const store = makeTaskStore(task);
    readAgentRunByIdMock.mockResolvedValue({
      id: "run-1",
      status: "completed",
      error: null,
      stepResults: [{ kind: "wayflow_response", output: "ok" }],
    });

    await poll(makeExecutor(store), new AbortController());

    expect(task.status.state).toBe("completed");
    expect(task.status.message).toBeUndefined();
    expect(task.artifacts).toHaveLength(1);
  });
});
