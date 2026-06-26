/**
 * CinatraResubscribeHandler + real Redis Streams cursor replay.
 *
 * Exercises the full path without mocking readRunEvents:
 *
 *   xaddRunEvent (seed events in Redis)
 *   → CinatraResubscribeHandler.resubscribe({ id }, { lastEventId: cursor })
 *   → readRunEvents(id, { fromId: cursor })    [real Redis, NOT mocked]
 *   → yielded events are post-cursor only AND carry metadata.eventId
 *
 * This proves the Last-Event-ID cursor is honoured end-to-end, including the
 * Redis Streams XRANGE call.  The browser EventSource auto-reconnect
 * behaviour is browser-spec (WHATWG EventSource §9.2) and depends solely on
 * the server emitting correct `id:` frames — which sse-response.test.ts verifies.
 *
 *
 * Guards on Redis availability (same pattern as event-log.test.ts).
 * Skipped automatically when Redis is unreachable.
 */
import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import type { Task, TaskState } from "@a2a-js/sdk";
import type { TaskStore } from "@a2a-js/sdk/server";

// The handler enforces run.read (via the actor-aware
// readAgentRunById / readAgentRunByTaskId resolver) before the real Redis
// replay. Mock both to authorize (resolve to the requested run id by PK).
vi.mock("@cinatra/agent-builder", () => ({
  readAgentRunByTaskId: vi.fn(async () => null),
  readAgentRunById: vi.fn(async (id: string) => ({ id })),
}));

import {
  xaddRunEvent,
  __disconnectSharedEventLogPublisher,
} from "../event-log";
import { CinatraResubscribeHandler } from "../resubscribe-handler";

// The verified actor is delivered on the SDK call context (iteration-safe).
const CTX = {
  a2aActorContext: {
    principalType: "HumanUser",
    principalId: "owner-1",
    organizationId: "org-1",
    authSource: "a2a",
    policyVersion: "v2",
  },
} as never;

// ---------------------------------------------------------------------------
// Infrastructure probes
// ---------------------------------------------------------------------------

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

async function isRedisReachable(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeout: 500,
    enableOfflineQueue: false,
  });
  try {
    await probe.connect();
    const pong = await probe.ping();
    return pong === "PONG";
  } catch {
    return false;
  } finally {
    await probe.quit().catch(() => {});
  }
}

let redisAvailable = false;
beforeAll(async () => {
  redisAvailable = await isRedisReachable();
});
afterAll(async () => {
  await __disconnectSharedEventLogPublisher();
});

// ---------------------------------------------------------------------------
// Helpers — same pattern as resubscribe-handler.test.ts
// ---------------------------------------------------------------------------

function buildMockAgentCard() {
  return {
    name: "test-agent",
    description: "test",
    url: "http://localhost/a2a",
    version: "1.0.0",
    capabilities: { streaming: true },
  };
}

function buildMockTaskStore(task: Task | undefined): TaskStore {
  return {
    load: async () => task,
    save: async () => undefined,
  } as unknown as TaskStore;
}

function buildTask(id: string, state: TaskState): Task {
  return {
    id,
    contextId: id,
    kind: "task",
    status: { state, timestamp: new Date().toISOString() },
    history: [],
  } as Task;
}

function buildHandler(task: Task): CinatraResubscribeHandler {
  return new CinatraResubscribeHandler(
    buildMockAgentCard() as never,
    buildMockTaskStore(task),
    { execute: async () => {}, cancelTask: async () => {} } as never,
  );
}

// Collect a resubscribe generator. The verified actor is delivered on the SDK
// call context (the iteration-safe path — survives the lazy SSE generator
// boundary where the ALS frame is no longer active).
async function collectGen(
  handler: CinatraResubscribeHandler,
  params: { id: string },
  ctx: never = CTX,
): Promise<unknown[]> {
  const results: unknown[] = [];
  for await (const val of handler.resubscribe(params, ctx)) results.push(val);
  return results;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CinatraResubscribeHandler — real Redis cursor replay", () => {
  it("replays only post-cursor events from Redis Streams when lastEventId is provided", async () => {
    if (!redisAvailable) {
      console.warn("[resubscribe-integration] Redis unreachable — skipping Redis replay integration");
      return;
    }

    const runId = randomUUID();

    // Seed three status-update events into the real Redis Stream.
    const id0 = await xaddRunEvent(runId, {
      kind: "status-update",
      taskId: runId,
      contextId: runId,
      status: { state: "submitted", timestamp: new Date().toISOString() },
      final: false,
    });
    const id1 = await xaddRunEvent(runId, {
      kind: "status-update",
      taskId: runId,
      contextId: runId,
      status: { state: "working", timestamp: new Date().toISOString() },
      final: false,
    });
    const id2 = await xaddRunEvent(runId, {
      kind: "status-update",
      taskId: runId,
      contextId: runId,
      status: { state: "completed", timestamp: new Date().toISOString() },
      final: true,
    });

    // Task is non-terminal so the handler reads the durable log.
    const task = buildTask(runId, "working");
    const handler = buildHandler(task);

    // Call resubscribe with lastEventId = id0 (the first event).
    // Expected: only id1 and id2 are replayed (exclusive cursor).
    const ctx = {
      lastEventId: id0,
      a2aActorContext: (CTX as unknown as { a2aActorContext: unknown }).a2aActorContext,
    } as never;
    const yielded = await collectGen(handler, { id: runId }, ctx);

    // First yield is always the Task snapshot.
    expect(yielded[0]).toMatchObject({ id: runId, kind: "task" });

    // id1 event should be the second yield with metadata.eventId stamped.
    const second = yielded[1] as { kind: string; metadata?: { eventId?: string } };
    expect(second.kind).toBe("status-update");
    expect(second.metadata?.eventId).toBe(id1);

    // id2 event (final=true) should be the third yield.
    const third = yielded[2] as {
      kind: string;
      final: boolean;
      metadata?: { eventId?: string };
    };
    expect(third.kind).toBe("status-update");
    expect(third.final).toBe(true);
    expect(third.metadata?.eventId).toBe(id2);

    // id0 must NOT appear — it was before the cursor.
    const eventIds = yielded
      .slice(1)
      .map((e) => (e as { metadata?: { eventId?: string } }).metadata?.eventId);
    expect(eventIds).not.toContain(id0);

    // Exactly 3 items: Task snapshot + 2 post-cursor events.
    expect(yielded).toHaveLength(3);
  });

  it("with no lastEventId, replays all events from the beginning", async () => {
    if (!redisAvailable) {
      console.warn("[resubscribe-integration] Redis unreachable — skipping Redis replay integration");
      return;
    }

    const runId = randomUUID();

    const idA = await xaddRunEvent(runId, {
      kind: "status-update",
      taskId: runId,
      contextId: runId,
      status: { state: "working", timestamp: new Date().toISOString() },
      final: false,
    });
    const idB = await xaddRunEvent(runId, {
      kind: "status-update",
      taskId: runId,
      contextId: runId,
      status: { state: "completed", timestamp: new Date().toISOString() },
      final: true,
    });

    const task = buildTask(runId, "working");
    const handler = buildHandler(task);

    // No lastEventId — replay from beginning.
    const yielded = await collectGen(handler, { id: runId });

    // Task snapshot + both events.
    expect(yielded).toHaveLength(3);
    const ids = yielded
      .slice(1)
      .map((e) => (e as { metadata?: { eventId?: string } }).metadata?.eventId);
    expect(ids).toContain(idA);
    expect(ids).toContain(idB);
  });
});
