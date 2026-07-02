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

// The handler enforces run.read (via the actor-aware
// readAgentRunById / readAgentRunByTaskId resolver) before any replay. Mock both.
vi.mock("@cinatra/agent-builder", () => ({
  readAgentRunById: vi.fn(),
  readAgentRunByTaskId: vi.fn(),
}));

import { readRunEvents } from "../event-log";
import { readAgentRunById, readAgentRunByTaskId } from "@cinatra-ai/agents";
import { CinatraResubscribeHandler } from "../resubscribe-handler";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockReadRunEvents = readRunEvents as unknown as ReturnType<typeof vi.fn>;
const mockReadRunById = readAgentRunById as unknown as ReturnType<typeof vi.fn>;
const mockReadByTask = readAgentRunByTaskId as unknown as ReturnType<typeof vi.fn>;

// The verified actor is delivered on the SDK call context (the route sets it).
// This is the iteration-safe path: it survives the lazy SSE generator boundary
// where the ALS frame is no longer active.
const CTX = {
  a2aActorContext: {
    principalType: "HumanUser",
    principalId: "owner-1",
    organizationId: "org-1",
    authSource: "a2a",
    policyVersion: "v2",
  },
} as never;

class FakeAuthzError extends Error {
  statusCode: number;
  reason: string;
  constructor(statusCode: number, reason: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.reason = reason;
  }
}

function collectAuthed(
  handler: CinatraResubscribeHandler,
  params: { id: string },
  ctx: never = CTX,
): Promise<unknown[]> {
  return (async () => {
    const results: unknown[] = [];
    for await (const val of handler.resubscribe(params, ctx)) results.push(val);
    return results;
  })();
}

function firstAuthed(
  handler: CinatraResubscribeHandler,
  params: { id: string },
  ctx: never = CTX,
): Promise<IteratorResult<unknown>> {
  return handler.resubscribe(params, ctx).next();
}

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

describe("CinatraResubscribeHandler — actor-bound replay", () => {
  beforeEach(() => {
    mockReadRunEvents.mockReset();
    mockReadRunById.mockReset();
    mockReadByTask.mockReset();
    // Default: id is a run PK — task-id lookup misses, PK existence + the
    // actor-aware authz re-read both resolve to the same id.
    mockReadByTask.mockResolvedValue(null);
    mockReadRunById.mockImplementation(async (id: string) => ({ id }));
  });

  it("first event yielded is the current Task from taskStore", async () => {
    const task = buildTask("run-1", "working");
    const taskStore = buildMockTaskStore(task);
    const handler = buildHandler(buildMockAgentCard(true), taskStore);

    mockReadRunEvents.mockReturnValue(mockAsyncGen([]));

    const first = await firstAuthed(handler, { id: "run-1" });
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ id: "run-1", kind: "task" });
  });

  it("enforces run.read for the actor BEFORE replay (cross-actor deny -> throws, no readRunEvents)", async () => {
    const task = buildTask("run-foreign", "working");
    const taskStore = buildMockTaskStore(task);
    const handler = buildHandler(buildMockAgentCard(true), taskStore);
    mockReadRunById.mockRejectedValue(new FakeAuthzError(403, "forbidden", "Run access denied."));

    await expect(firstAuthed(handler, { id: "run-foreign" })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mockReadRunEvents).not.toHaveBeenCalled();
  });

  it("terminal task state yields Task and returns immediately (no replay)", async () => {
    const terminalStates: TaskState[] = ["completed", "failed", "canceled", "rejected"];

    for (const state of terminalStates) {
      mockReadRunEvents.mockReset();
      const task = buildTask(`run-${state}`, state);
      const taskStore = buildMockTaskStore(task);
      const handler = buildHandler(buildMockAgentCard(true), taskStore);

      const yielded = await collectAuthed(handler, { id: `run-${state}` });

      expect(yielded).toHaveLength(1);
      expect((yielded[0] as Task).status.state).toBe(state);
      expect(mockReadRunEvents).not.toHaveBeenCalled();
    }
  });

  it("lastEventId forwarded to readRunEvents — replay keyed on the AUTHORIZED run id", async () => {
    const task = buildTask("run-2", "working");
    const taskStore = buildMockTaskStore(task);
    const handler = buildHandler(buildMockAgentCard(true), taskStore);

    mockReadRunEvents.mockReturnValue(mockAsyncGen([]));

    const ctx = {
      lastEventId: "event-start",
      a2aActorContext: (CTX as unknown as { a2aActorContext: unknown }).a2aActorContext,
    } as never;
    await collectAuthed(handler, { id: "run-2" }, ctx);

    expect(mockReadRunEvents).toHaveBeenCalledOnce();
    const [calledRunId, calledOpts] = mockReadRunEvents.mock.calls[0] as [
      string,
      { fromId?: string },
    ];
    expect(calledRunId).toBe("run-2");
    expect(calledOpts.fromId).toBe("event-start");
  });

  it("missing/unauthorized run throws A2AError.taskNotFound (and never replays)", async () => {
    const taskStore = buildMockTaskStore(undefined);
    const handler = buildHandler(buildMockAgentCard(true), taskStore);
    mockReadRunById.mockResolvedValue(null);

    await expect(firstAuthed(handler, { id: "missing-run" })).rejects.toMatchObject({
      code: expect.any(Number),
    });
    expect(mockReadRunEvents).not.toHaveBeenCalled();
  });

  it("agentCard.capabilities.streaming === false throws unsupportedOperation", async () => {
    const task = buildTask("run-3", "working");
    const taskStore = buildMockTaskStore(task);
    const handler = buildHandler(buildMockAgentCard(false), taskStore);

    await expect(firstAuthed(handler, { id: "run-3" })).rejects.toMatchObject({
      code: expect.any(Number),
    });
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

    const yielded = await collectAuthed(handler, { id: "run-4" });

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
