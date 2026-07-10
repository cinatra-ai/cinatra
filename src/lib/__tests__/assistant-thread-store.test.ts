// Unit tests for the structured assistant-thread + turn store (cinatra#1037 P2a).
// The postgres sync leaves are mocked so the pure mappers + query assembly are
// exercised without a database; the live schema execution is covered by the
// bootstrap DDL + core__0021 migration test + upgrade-proof.
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

  it("maps an assistant_turns row and keeps the run pointer + principal", () => {
    const turn = mapAssistantTurnRow({
      id: "tn1",
      thread_id: "th1",
      run_id: "run-abc",
      assistant_user_id: "au1",
      role: "assistant",
      status: "completed",
      created_at: "2026-07-10T10:00:00.000Z",
      updated_at: "2026-07-10T10:05:00.000Z",
    });
    expect(turn.runId).toBe("run-abc");
    expect(turn.assistantUserId).toBe("au1");
    expect(turn.status).toBe("completed");
    expect(turn.role).toBe("assistant");
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
    const q = runPostgresQueriesSync.mock.calls[0][0].queries[0];
    expect(q.values).toEqual(["tn1", "th1", "run-1", "au1", "assistant", "running"]);
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
});
