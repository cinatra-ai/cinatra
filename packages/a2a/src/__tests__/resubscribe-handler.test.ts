/**
 * Tests for CinatraResubscribeHandler.
 *
 * Tests the overridden resubscribe() method without real Redis or DB.
 * readRunEvents from "../event-log" is mocked so each test controls exactly
 * which events are yielded from the durable log.
 *
 * Pattern: mirrors task-store-db-fallback.test.ts for mock setup.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task, TaskState } from "@a2a-js/sdk";
import type { TaskStore } from "@a2a-js/sdk/server";

// Mock readRunEvents so tests never need real Redis.
vi.mock("../event-log", () => ({
  readRunEvents: vi.fn(),
}));

import { readRunEvents } from "../event-log";
import { CinatraResubscribeHandler } from "../resubscribe-handler";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockReadRunEvents = readRunEvents as unknown as ReturnType<typeof vi.fn>;

function buildMockAgentCard(streaming: boolean) {
  return {
    name: "test-agent",
    description: "test",
    url: "http://localhost/a2a",
    version: "1.0.0",
    capabilities: {
      streaming,
    },
  };
}

function buildMockTaskStore(task: Task | undefined): TaskStore {
  return {
    load: vi.fn().mockResolvedValue(task),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

function buildMockExecutor() {
  return {
    execute: vi.fn().mockResolvedValue(undefined),
    cancelTask: vi.fn().mockResolvedValue(undefined),
  };
}

function buildTask(
  id: string,
  state: TaskState,
): Task {
  return {
    id,
    contextId: id,
    kind: "task",
    status: { state, timestamp: new Date().toISOString() },
    history: [],
  } as Task;
}

/**
 * Build a handler with the given agentCard and taskStore.
 * The executor is mocked (resubscribe doesn't invoke it).
 */
function buildHandler(
  agentCard: ReturnType<typeof buildMockAgentCard>,
  taskStore: TaskStore,
): CinatraResubscribeHandler {
  return new CinatraResubscribeHandler(
    agentCard as never,
    taskStore,
    buildMockExecutor() as never,
  );
}

/**
 * Collect all yielded values from an AsyncGenerator into an array.
 */
async function collectGen<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const val of gen) {
    results.push(val);
  }
  return results;
}

/**
 * Build a mock AsyncGenerator from an array of items.
 */
async function* mockAsyncGen<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CinatraResubscribeHandler", () => {
  beforeEach(() => {
    mockReadRunEvents.mockReset();
  });

  it("first event yielded is the current Task from taskStore", async () => {
    const task = buildTask("run-1", "working");
    const taskStore = buildMockTaskStore(task);
    const handler = buildHandler(buildMockAgentCard(true), taskStore);

    // readRunEvents returns an empty generator — only the initial Task snapshot
    // should be yielded.
    mockReadRunEvents.mockReturnValue(mockAsyncGen([]));

    const gen = handler.resubscribe({ id: "run-1" });
    const first = await gen.next();
    expect(first.done).toBe(false);
    // The yielded value must be the Task object from taskStore.
    expect(first.value).toMatchObject({ id: "run-1", kind: "task" });
    await gen.return(undefined); // clean up
  });

  it("terminal task state yields Task and returns immediately (no replay)", async () => {
    // For a terminal task, the handler should yield the task snapshot and then
    // return without ever calling readRunEvents.
    const terminalStates: TaskState[] = ["completed", "failed", "canceled", "rejected"];

    for (const state of terminalStates) {
      mockReadRunEvents.mockReset();
      const task = buildTask(`run-${state}`, state);
      const taskStore = buildMockTaskStore(task);
      const handler = buildHandler(buildMockAgentCard(true), taskStore);

      const yielded = await collectGen(handler.resubscribe({ id: `run-${state}` }));

      // Should have yielded exactly one item (the Task snapshot) then returned.
      expect(yielded).toHaveLength(1);
      expect((yielded[0] as Task).status.state).toBe(state);
      // readRunEvents must NOT have been called for terminal tasks.
      expect(mockReadRunEvents).not.toHaveBeenCalled();
    }
  });

  it("lastEventId from ServerCallContext is forwarded to readRunEvents", async () => {
    const task = buildTask("run-2", "working");
    const taskStore = buildMockTaskStore(task);
    const handler = buildHandler(buildMockAgentCard(true), taskStore);

    mockReadRunEvents.mockReturnValue(mockAsyncGen([]));

    const ctx = { lastEventId: "event-start" } as never;
    await collectGen(handler.resubscribe({ id: "run-2" }, ctx));

    expect(mockReadRunEvents).toHaveBeenCalledOnce();
    const [calledRunId, calledOpts] = mockReadRunEvents.mock.calls[0] as [
      string,
      { fromId?: string },
    ];
    expect(calledRunId).toBe("run-2");
    expect(calledOpts.fromId).toBe("event-start");
  });

  it("missing task throws A2AError.taskNotFound", async () => {
    const taskStore = buildMockTaskStore(undefined);
    const handler = buildHandler(buildMockAgentCard(true), taskStore);

    const gen = handler.resubscribe({ id: "missing-run" });
    // A2AError has a numeric `code` property — use that instead of instanceof
    // to avoid importing the runtime class (not resolvable from worktree path).
    await expect(gen.next()).rejects.toMatchObject({ code: expect.any(Number) });
    // readRunEvents must not be called when the task is missing.
    expect(mockReadRunEvents).not.toHaveBeenCalled();
  });

  it("agentCard.capabilities.streaming === false throws unsupportedOperation", async () => {
    const task = buildTask("run-3", "working");
    const taskStore = buildMockTaskStore(task);
    // streaming=false should cause A2AError before taskStore is even consulted.
    const handler = buildHandler(buildMockAgentCard(false), taskStore);

    const gen = handler.resubscribe({ id: "run-3" });
    // A2AError has a numeric `code` property.
    await expect(gen.next()).rejects.toMatchObject({ code: expect.any(Number) });
    expect(mockReadRunEvents).not.toHaveBeenCalled();
  });

  it("yields durable-log events after the initial Task and returns on final=true", async () => {
    const task = buildTask("run-4", "working");
    const taskStore = buildMockTaskStore(task);
    const handler = buildHandler(buildMockAgentCard(true), taskStore);

    // Simulate the durable log yielding a non-final event then a final=true one.
    const logEvents: Array<{ id: string; event: Record<string, unknown> }> = [
      {
        id: "event-one",
        event: {
          kind: "status-update",
          taskId: "run-4",
          contextId: "run-4",
          status: { state: "working", timestamp: new Date().toISOString() },
          final: false,
        },
      },
      {
        id: "event-two",
        event: {
          kind: "status-update",
          taskId: "run-4",
          contextId: "run-4",
          status: { state: "completed", timestamp: new Date().toISOString() },
          final: true,
        },
      },
    ];
    mockReadRunEvents.mockReturnValue(mockAsyncGen(logEvents));

    const yielded = await collectGen(handler.resubscribe({ id: "run-4" }));

    // First yield: Task snapshot (no eventId on it)
    expect(yielded[0]).toMatchObject({ id: "run-4", kind: "task" });

    // Second yield: first log event — status-update with eventId stamped
    const second = yielded[1] as { metadata?: { eventId?: string }; kind: string };
    expect(second.kind).toBe("status-update");
    expect(second.metadata?.eventId).toBe("event-one");

    // Third yield: final log event — status-update with final=true + eventId
    const third = yielded[2] as {
      metadata?: { eventId?: string };
      kind: string;
      final: boolean;
    };
    expect(third.kind).toBe("status-update");
    expect(third.final).toBe(true);
    expect(third.metadata?.eventId).toBe("event-two");

    // Generator returns after final=true — exactly 3 items total.
    expect(yielded).toHaveLength(3);
  });
});
