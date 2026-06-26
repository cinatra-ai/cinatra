/**
 * Tests for createA2ATaskStoreWithDbFallback.
 *
 * BOTH the in-memory hit path and the DB-fallback path are bound to the verified
 * actor (fail-closed). The actor is resolved from the SDK call context's
 * `a2aActorContext`. The A2A id may be a task id (a2a_task_id) OR a run id;
 * resolveAuthorizedRunForA2AId tries readAgentRunByTaskId then readAgentRunById,
 * then authorizes run.read via readAgentRunById(run.id, actor).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task } from "@a2a-js/sdk";
import type { TaskStore } from "@a2a-js/sdk/server";

vi.mock("@cinatra/agent-builder", () => ({
  readAgentRunById: vi.fn(),
  readAgentRunByTaskId: vi.fn(),
}));

// Control the ALS fallback so the "no actor anywhere" path can be exercised
// (the default test stub otherwise returns a non-undefined default ctx).
vi.mock("@cinatra-ai/llm/actor-context", () => ({
  getActorContext: vi.fn(() => undefined),
  getActorContextOrThrow: vi.fn(() => {
    throw new Error("no actor");
  }),
  withActorContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  actorContextStorage: { getStore: () => undefined },
}));

import { readAgentRunById, readAgentRunByTaskId } from "@cinatra-ai/agents";
import { createA2ATaskStoreWithDbFallback } from "../task-store-db-fallback";

const mockReadById = readAgentRunById as unknown as ReturnType<typeof vi.fn>;
const mockReadByTask = readAgentRunByTaskId as unknown as ReturnType<typeof vi.fn>;

// SDK call context carrying the verified actor (the route sets this).
const CTX = {
  a2aActorContext: {
    principalType: "HumanUser",
    principalId: "owner-1",
    organizationId: "org-1",
    authSource: "a2a",
    policyVersion: "v2",
  },
} as never;

function buildInner(override: Partial<TaskStore> = {}): TaskStore {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(undefined),
    ...override,
  };
}

class FakeAuthzError extends Error {
  statusCode: number;
  reason: string;
  constructor(statusCode: number, reason: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.reason = reason;
  }
}

describe("createA2ATaskStoreWithDbFallback — actor-bound reads", () => {
  beforeEach(() => {
    mockReadById.mockReset();
    mockReadByTask.mockReset();
    mockReadByTask.mockResolvedValue(null);
    mockReadById.mockResolvedValue(null);
  });

  it("gates the in-memory HIT path (authorizes via the actor before returning the hit)", async () => {
    const innerTask: Task = {
      id: "task-live-1",
      contextId: "ctx-1",
      kind: "task",
      status: { state: "working", timestamp: new Date().toISOString() },
      history: [],
    } as Task;
    const inner = buildInner({ load: vi.fn().mockResolvedValue(innerTask) });
    // Live task: the id is a SEPARATE a2a_task_id (NOT the run PK). The first
    // lookup (readAgentRunByTaskId) resolves it to run "run-9".
    mockReadByTask.mockResolvedValue({ id: "run-9" });
    // Authorization re-read by run.id succeeds.
    mockReadById.mockResolvedValue({ id: "run-9", status: "running", stepResults: null, error: null });
    const store = createA2ATaskStoreWithDbFallback(inner);

    const got = await store.load("task-live-1", CTX);
    expect(got).toBe(innerTask);
    // Resolved by task-id (NOT by PK) — proves the taskId!=runId form works.
    expect(mockReadByTask).toHaveBeenCalledWith("task-live-1");
    // Authorized via the actor-aware run-id re-read.
    expect(mockReadById).toHaveBeenCalledWith(
      "run-9",
      expect.objectContaining({ userId: "owner-1", source: "a2a" }),
    );
  });

  it("cross-actor DENY on the HIT path — authorization throws, load rejects (no hit leak)", async () => {
    const innerTask: Task = {
      id: "task-foreign",
      contextId: "c",
      kind: "task",
      status: { state: "working", timestamp: new Date().toISOString() },
      history: [],
    } as Task;
    const inner = buildInner({ load: vi.fn().mockResolvedValue(innerTask) });
    mockReadByTask.mockResolvedValue({ id: "run-foreign" });
    mockReadById.mockRejectedValue(new FakeAuthzError(403, "forbidden", "Run access denied."));
    const store = createA2ATaskStoreWithDbFallback(inner);

    await expect(store.load("task-foreign", CTX)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("cross-actor DENY on the DB-fallback path", async () => {
    const inner = buildInner({ load: vi.fn().mockResolvedValue(undefined) });
    // id is a run PK (terminal recovery): task-id lookup misses, PK lookup hits.
    mockReadByTask.mockResolvedValue(null);
    mockReadById
      .mockResolvedValueOnce({ id: "run-x" }) // existence probe by PK
      .mockRejectedValueOnce(new FakeAuthzError(404, "hidden", "Not found.")); // authz re-read
    const store = createA2ATaskStoreWithDbFallback(inner);

    await expect(store.load("run-x", CTX)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("fail-closed: no actor on the context (and no ALS frame) -> load throws (never reads without an actor)", async () => {
    const inner = buildInner({ load: vi.fn().mockResolvedValue(undefined) });
    const store = createA2ATaskStoreWithDbFallback(inner);
    // No a2aActorContext and (in this unit env) no ALS frame -> requireA2AActor throws.
    await expect(store.load("anything", {} as never)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("authorized DB-fallback (run-id form) — synthesizes a Task with correct state mapping", async () => {
    const inner = buildInner({ load: vi.fn().mockResolvedValue(undefined) });
    mockReadByTask.mockResolvedValue(null);
    mockReadById
      .mockResolvedValueOnce({ id: "run-42" }) // PK existence probe
      .mockResolvedValueOnce({ id: "run-42", status: "completed", stepResults: [{ foo: "bar" }], error: null }); // authz re-read
    const store = createA2ATaskStoreWithDbFallback(inner);
    const got = await store.load("run-42", CTX);
    expect(got).toBeDefined();
    expect(got?.id).toBe("run-42");
    expect(got?.status.state).toBe("completed");
    expect(got?.artifacts?.length).toBe(1);
  });

  it("authorized DB-fallback with error — status.message carries the error text", async () => {
    const inner = buildInner({ load: vi.fn().mockResolvedValue(undefined) });
    mockReadByTask.mockResolvedValue({ id: "run-err" });
    mockReadById.mockResolvedValue({ id: "run-err", status: "failed", stepResults: null, error: "boom" });
    const store = createA2ATaskStoreWithDbFallback(inner);
    const got = await store.load("task-err", CTX);
    expect(got?.status.state).toBe("failed");
    expect(got?.status.message?.parts?.[0]).toMatchObject({ kind: "text", text: "boom" });
  });

  it("authorized but no run matches either id form — returns undefined", async () => {
    const inner = buildInner({ load: vi.fn().mockResolvedValue(undefined) });
    mockReadByTask.mockResolvedValue(null);
    mockReadById.mockResolvedValue(null);
    const store = createA2ATaskStoreWithDbFallback(inner);
    const got = await store.load("does-not-exist", CTX);
    expect(got).toBeUndefined();
  });

  it("FAIL-CLOSED — an in-memory HIT is NOT returned when no run row resolves (no unauthorized leak)", async () => {
    // A live in-memory task exists, but NO agent_runs row matches either id form
    // (e.g. run row not yet committed, or stale a2a_task_id). The hit must NOT be
    // returned because enforceRunAccess never ran.
    const innerTask: Task = {
      id: "task-orphan",
      contextId: "c",
      kind: "task",
      status: { state: "working", timestamp: new Date().toISOString() },
      history: [],
    } as Task;
    const inner = buildInner({ load: vi.fn().mockResolvedValue(innerTask) });
    mockReadByTask.mockResolvedValue(null);
    mockReadById.mockResolvedValue(null);
    const store = createA2ATaskStoreWithDbFallback(inner);
    const got = await store.load("task-orphan", CTX);
    expect(got).toBeUndefined();
  });

  it("save — delegates to inner.save (no authz on writes here)", async () => {
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
