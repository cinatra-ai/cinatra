/**
 * Tests for createA2ATaskStoreWithDbFallback.
 *
 * No DB involvement; `@cinatra/agent-builder` is fully mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task } from "@a2a-js/sdk";
import type { TaskStore } from "@a2a-js/sdk/server";

vi.mock("@cinatra/agent-builder", () => ({
  readAgentRunById: vi.fn(),
}));

import { readAgentRunById } from "@cinatra-ai/agents";
import { createA2ATaskStoreWithDbFallback } from "../task-store-db-fallback";

const mockRead = readAgentRunById as unknown as ReturnType<typeof vi.fn>;

function buildInner(override: Partial<TaskStore> = {}): TaskStore {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(undefined),
    ...override,
  };
}

describe("createA2ATaskStoreWithDbFallback", () => {
  beforeEach(() => {
    mockRead.mockReset();
  });

  it("inner hit — returns inner result and does not consult the DB", async () => {
    const innerTask: Task = {
      id: "t-1",
      contextId: "t-1",
      kind: "task",
      status: { state: "working", timestamp: new Date().toISOString() },
      history: [],
    } as Task;
    const inner = buildInner({
      load: vi.fn().mockResolvedValueOnce(innerTask),
    });
    const store = createA2ATaskStoreWithDbFallback(inner);
    const got = await store.load("t-1");
    expect(got).toBe(innerTask);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("inner miss + DB hit — synthesizes a Task with correct state mapping", async () => {
    const inner = buildInner({
      load: vi.fn().mockResolvedValueOnce(undefined),
    });
    mockRead.mockResolvedValueOnce({
      id: "run-42",
      status: "completed",
      stepResults: [{ foo: "bar" }],
      error: null,
    });
    const store = createA2ATaskStoreWithDbFallback(inner);
    const got = await store.load("run-42");
    expect(got).toBeDefined();
    expect(got?.id).toBe("run-42");
    expect(got?.kind).toBe("task");
    expect(got?.status.state).toBe("completed");
    expect(Array.isArray(got?.artifacts)).toBe(true);
    expect(got?.artifacts?.length).toBe(1);
  });

  it("inner miss + DB hit with error — status.message carries the error text", async () => {
    const inner = buildInner({
      load: vi.fn().mockResolvedValueOnce(undefined),
    });
    mockRead.mockResolvedValueOnce({
      id: "run-err",
      status: "failed",
      stepResults: null,
      error: "boom",
    });
    const store = createA2ATaskStoreWithDbFallback(inner);
    const got = await store.load("run-err");
    expect(got?.status.state).toBe("failed");
    const msg = got?.status.message;
    expect(msg?.parts?.[0]).toMatchObject({ kind: "text", text: "boom" });
  });

  it("inner miss + DB miss — returns undefined", async () => {
    const inner = buildInner({
      load: vi.fn().mockResolvedValueOnce(undefined),
    });
    mockRead.mockResolvedValueOnce(null);
    const store = createA2ATaskStoreWithDbFallback(inner);
    const got = await store.load("does-not-exist");
    expect(got).toBeUndefined();
  });

  it("save — delegates to inner.save", async () => {
    const saveSpy = vi.fn().mockResolvedValue(undefined);
    const inner = buildInner({ save: saveSpy });
    const store = createA2ATaskStoreWithDbFallback(inner);
    const task: Task = {
      id: "t-save",
      contextId: "t-save",
      kind: "task",
      status: { state: "working", timestamp: new Date().toISOString() },
      history: [],
    } as Task;
    await store.save(task);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith(task, undefined);
  });
});
