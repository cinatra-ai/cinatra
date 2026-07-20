// Unit tests for the structured assistant-thread + turn store (cinatra#1037 P2a).
// The postgres sync leaves are mocked so the pure mappers + query assembly are
// exercised without a database; the live schema execution is covered by the
// bootstrap DDL + core__0026 migration test + upgrade-proof.
import { describe, expect, it, vi, beforeEach } from "vitest";

const runPostgresQueriesSync = vi.fn();

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...a: unknown[]) => runPostgresQueriesSync(...a),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "app_test",
}));
vi.mock("@/lib/postgres-schema-init", () => ({
  ensurePostgresSchema: () => undefined,
}));

import {
  mapAssistantThreadRow,
  mapAssistantTurnRow,
  isAssistantTurnStatus,
  isAssistantTurnRole,
  createAssistantThread,
  appendAssistantTurn,
  updateAssistantTurn,
} from "../assistant-thread-store";

describe("pure row mappers", () => {
  it("maps an assistant_threads row (nulls preserved, dates → ISO)", () => {
    const created = new Date("2026-07-10T10:00:00.000Z");
    const t = mapAssistantThreadRow({
      id: "th1",
      assistant_user_id: "au1",
      owner_user_id: null,
      org_id: "org1",
      title: "My chat",
      context_id: "ctx1",
      created_at: created,
      updated_at: "2026-07-10T11:00:00.000Z",
    });
    expect(t).toEqual({
      id: "th1",
      assistantUserId: "au1",
      ownerUserId: null,
      orgId: "org1",
      title: "My chat",
      contextId: "ctx1",
      createdAt: "2026-07-10T10:00:00.000Z",
      updatedAt: "2026-07-10T11:00:00.000Z",
    });
  });

  it("maps an assistant_turns row and keeps the run pointer + principal + content", () => {
    const turn = mapAssistantTurnRow({
      id: "tn1",
      thread_id: "th1",
      run_id: "run-abc",
      assistant_user_id: "au1",
      role: "assistant",
      status: "completed",
      // jsonb already parsed by the pg driver → a plain object.
      content: { format: "assistant-turn-v1", role: "assistant", content: "hi", parts: [] },
      created_at: "2026-07-10T10:00:00.000Z",
      updated_at: "2026-07-10T10:05:00.000Z",
    });
    expect(turn.runId).toBe("run-abc");
    expect(turn.assistantUserId).toBe("au1");
    expect(turn.status).toBe("completed");
    expect(turn.role).toBe("assistant");
    expect(turn.content).toEqual({ format: "assistant-turn-v1", role: "assistant", content: "hi", parts: [] });
  });

  it("content is null when absent, and a raw JSON string is tolerated defensively", () => {
    expect(mapAssistantTurnRow({ id: "t", thread_id: "th", role: "user", status: "completed" }).content).toBeNull();
    // a non-object jsonb value (array/scalar) → null
    expect(mapAssistantTurnRow({ id: "t", thread_id: "th", content: [1, 2] }).content).toBeNull();
    // a driver that hands back the raw text is parsed
    expect(
      mapAssistantTurnRow({ id: "t", thread_id: "th", content: '{"a":1}' }).content,
    ).toEqual({ a: 1 });
  });

  it("falls back to schema defaults for an out-of-domain role/status", () => {
    const turn = mapAssistantTurnRow({
      id: "tn2",
      thread_id: "th1",
      run_id: null,
      role: "weird",
      status: "bogus",
    });
    expect(turn.role).toBe("assistant");
    expect(turn.status).toBe("running");
    expect(turn.runId).toBeNull();
    expect(turn.content).toBeNull();
  });
});

describe("domain guards", () => {
  it("validates turn status", () => {
    expect(isAssistantTurnStatus("running")).toBe(true);
    expect(isAssistantTurnStatus("completed")).toBe(true);
    expect(isAssistantTurnStatus("error")).toBe(true);
    expect(isAssistantTurnStatus("paused")).toBe(false);
  });
  it("validates turn role", () => {
    expect(isAssistantTurnRole("user")).toBe(true);
    expect(isAssistantTurnRole("assistant")).toBe(true);
    expect(isAssistantTurnRole("system")).toBe(false);
  });
});

describe("query assembly", () => {
  beforeEach(() => runPostgresQueriesSync.mockReset());

  it("createAssistantThread inserts the typed columns and maps the RETURNING row", () => {
    runPostgresQueriesSync.mockReturnValue([
      {
        rows: [
          {
            id: "th1",
            assistant_user_id: "au1",
            owner_user_id: "u1",
            org_id: "org1",
            title: null,
            context_id: null,
            created_at: "2026-07-10T10:00:00.000Z",
            updated_at: "2026-07-10T10:00:00.000Z",
          },
        ],
      },
    ]);
    const t = createAssistantThread({
      id: "th1",
      assistantUserId: "au1",
      ownerUserId: "u1",
      orgId: "org1",
    });
    expect(t.id).toBe("th1");
    const call = runPostgresQueriesSync.mock.calls[0][0];
    const q = call.queries[0];
    expect(q.text.toLowerCase()).toContain('insert into "app_test"."assistant_threads"');
    expect(q.text.toLowerCase()).toContain("returning");
    expect(q.values).toEqual(["th1", "au1", "u1", "org1", null, null]);
  });

  it("appendAssistantTurn inserts thread_id/run_id/principal/role/status", () => {
    runPostgresQueriesSync.mockReturnValue([
      {
        rows: [
          {
            id: "tn1",
            thread_id: "th1",
            run_id: "run-1",
            assistant_user_id: "au1",
            role: "assistant",
            status: "running",
            content: null,
            created_at: "2026-07-10T10:00:00.000Z",
            updated_at: "2026-07-10T10:00:00.000Z",
          },
        ],
      },
    ]);
    const turn = appendAssistantTurn({
      id: "tn1",
      threadId: "th1",
      runId: "run-1",
      assistantUserId: "au1",
    });
    expect(turn.threadId).toBe("th1");
    expect(turn.content).toBeNull();
    const q = runPostgresQueriesSync.mock.calls[0][0].queries[0];
    // content ($7) defaults to null when not supplied at insert.
    expect(q.text).toContain("content");
    expect(q.values).toEqual(["tn1", "th1", "run-1", "au1", "assistant", "running", null]);
  });

  it("appendAssistantTurn fail-loud rejects ids in the reserved legacy-mirror namespace (P2b)", async () => {
    // The mirror's reconcile DELETE is scoped to this prefix; a store-minted
    // row inside it could be deleted by a legacy chat_threads write.
    expect(() =>
      appendAssistantTurn({ id: "legacy:2:th:m1", threadId: "th1" }),
    ).toThrow(/reserved for the legacy chat_threads mirror/);
    expect(runPostgresQueriesSync).not.toHaveBeenCalled();
    // Cross-module pin: the store's reserved prefix must equal the mirror's.
    const store = await import("../assistant-thread-store");
    const inheritance = await import("../project-inheritance");
    expect(store.RESERVED_LEGACY_MIRROR_TURN_ID_PREFIX).toBe(
      inheritance.LEGACY_MIRROR_TURN_ID_PREFIX,
    );
  });

  it("updateAssistantTurn builds a partial SET with status + run binding", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [] }]);
    updateAssistantTurn("tn1", { status: "completed", runId: "run-1" });
    const q = runPostgresQueriesSync.mock.calls[0][0].queries[0];
    expect(q.text.toLowerCase()).toContain("update");
    expect(q.text).toContain("status = $1");
    expect(q.text).toContain("run_id = $2");
    // turnId is the last positional param.
    expect(q.values).toEqual(["completed", "run-1", "tn1"]);
  });

  it("updateAssistantTurn writes durable content when the key is present (PR1 EXPAND)", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [] }]);
    const content = { format: "assistant-turn-v1", role: "assistant", content: "done", parts: [] };
    updateAssistantTurn("tn1", { status: "completed", content });
    const q = runPostgresQueriesSync.mock.calls[0][0].queries[0];
    expect(q.text).toContain("status = $1");
    expect(q.text).toContain("content = $2::jsonb");
    // content is serialized to a JSON string for the jsonb cast; turnId last.
    expect(q.values).toEqual(["completed", JSON.stringify(content), "tn1"]);
  });

  it("updateAssistantTurn clears content on explicit null (key present)", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [] }]);
    updateAssistantTurn("tn1", { content: null });
    const q = runPostgresQueriesSync.mock.calls[0][0].queries[0];
    expect(q.text).toContain("content = $1::jsonb");
    expect(q.values).toEqual([null, "tn1"]);
  });
});
