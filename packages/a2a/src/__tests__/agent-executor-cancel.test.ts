/**
 * Regression tests for cancelTask contextId propagation (issue #77).
 *
 * The in-process executor used to publish its terminal `canceled`
 * status-update with `contextId: ""` because no taskId → contextId mapping
 * was maintained. These tests assert:
 *
 *   1) cancelTask publishes the ORIGINATING contextId for an active task
 *      (taskToContext map populated by execute()).
 *   2) cancelTask falls back to the task store when the in-memory map no
 *      longer holds the task (e.g. the background poller cleaned up after
 *      the run parked at input-required — non-terminal, still cancelable).
 *   3) cancelTask degrades to "" (never throws) when neither source knows
 *      the task.
 *
 *   pnpm vitest run src/__tests__/agent-executor-cancel.test.ts
 * from `packages/a2a/`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const agentBuilder = vi.hoisted(() => ({
  createAgentRun: vi.fn(async () => undefined),
  readAgentRunById: vi.fn(async () => null as any),
  updateAgentRunA2ATaskId: vi.fn(async () => undefined),
  readAgentTemplateById: vi.fn(),
  jsonSchemaToZod: vi.fn(),
}));
vi.mock("@cinatra/agent-builder", () => agentBuilder);

vi.mock("../streaming-bridge", () => ({
  publishRunEvent: vi.fn(async () => undefined),
}));

import { InMemoryTaskStore } from "@a2a-js/sdk/server";

import { InProcessAgentExecutor } from "../agent-executor";

function makeRequestContext(taskId: string, contextId: string): any {
  return {
    taskId,
    contextId,
    userMessage: { parts: [{ kind: "text", text: "hi" }] },
  };
}

function makeEventBus() {
  const published: any[] = [];
  return {
    published,
    publish: vi.fn((e: any) => {
      published.push(e);
    }),
    finished: vi.fn(),
  };
}

function canceledEvents(published: any[]) {
  return published.filter(
    (e) => e.kind === "status-update" && e.status?.state === "canceled",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("InProcessAgentExecutor — cancelTask contextId propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentBuilder.readAgentTemplateById.mockResolvedValue({
      id: "tpl_1",
      inputSchema: {},
    });
    // Keep the run non-terminal so the background poller stays alive (and the
    // taskToContext entry stays populated) until cancelTask aborts it.
    agentBuilder.readAgentRunById.mockResolvedValue({ status: "running" });
  });

  it("publishes the originating contextId on cancel of an active task", async () => {
    const executor = new InProcessAgentExecutor({
      templateId: "tpl_1",
      enqueueJob: vi.fn(async () => undefined) as any,
      pollIntervalMs: 5,
      pollTimeoutMs: 1000,
    } as any);

    const executeBus = makeEventBus();
    await executor.execute(
      makeRequestContext("task_c1", "ctx_c1"),
      executeBus as any,
    );

    const cancelBus = makeEventBus();
    await executor.cancelTask("task_c1", cancelBus as any);

    const canceled = canceledEvents(cancelBus.published);
    expect(canceled.length).toBe(1);
    expect(canceled[0].taskId).toBe("task_c1");
    // The whole point of issue #77: the cancel event MUST carry the real
    // contextId, not "".
    expect(canceled[0].contextId).toBe("ctx_c1");
    expect(canceled[0].final).toBe(true);

    // Let the aborted background poll tick once and exit cleanly.
    await sleep(15);
  });

  it("falls back to the task store contextId when the in-memory map was cleaned up", async () => {
    const taskStore = new InMemoryTaskStore();
    await taskStore.save({
      kind: "task",
      id: "task_c2",
      contextId: "ctx_c2",
      status: {
        state: "input-required",
        timestamp: new Date().toISOString(),
      },
      history: [],
    } as any);

    const executor = new InProcessAgentExecutor({
      templateId: "tpl_1",
      enqueueJob: vi.fn(async () => undefined) as any,
      pollIntervalMs: 5,
      pollTimeoutMs: 1000,
      taskStore,
    } as any);

    // No execute() for task_c2 — simulates the post-cleanup window where only
    // the task store still knows the context.
    const cancelBus = makeEventBus();
    await executor.cancelTask("task_c2", cancelBus as any);

    const canceled = canceledEvents(cancelBus.published);
    expect(canceled.length).toBe(1);
    expect(canceled[0].contextId).toBe("ctx_c2");
    expect(canceled[0].final).toBe(true);
  });

  it('degrades to contextId "" when neither map nor store knows the task', async () => {
    const executor = new InProcessAgentExecutor({
      templateId: "tpl_1",
      enqueueJob: vi.fn(async () => undefined) as any,
      pollIntervalMs: 5,
      pollTimeoutMs: 1000,
      taskStore: new InMemoryTaskStore(),
    } as any);

    const cancelBus = makeEventBus();
    await executor.cancelTask("task_unknown", cancelBus as any);

    const canceled = canceledEvents(cancelBus.published);
    expect(canceled.length).toBe(1);
    expect(canceled[0].contextId).toBe("");
  });
});
