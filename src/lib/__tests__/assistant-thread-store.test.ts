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
  listPausedParticipants,
  listAssistantThreadIdsWithDurableContent,
  assembleThreadPayloadFromParts,
  reconstructThreadPayload,
} from "../assistant-thread-store";
import type { AssistantThread, AssistantTurn } from "../assistant-thread-store";

describe("pure row mappers", () => {
  it("maps an assistant_threads row (nulls preserved, dates → ISO)", () => {
    const created = new Date("2026-07-10T10:00:00.000Z");
    const t = mapAssistantThreadRow({
      id: "th1",
      assistant_user_id: "au1",
      owner_user_id: null,
      org_id: "org1",
      project_id: "proj-9",
      origin: "legacy-chat",
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
      projectId: "proj-9",
      teamId: null,
      origin: "legacy-chat",
      title: "My chat",
      contextId: "ctx1",
      createdAt: "2026-07-10T10:00:00.000Z",
      updatedAt: "2026-07-10T11:00:00.000Z",
    });
  });

  it("maps origin to the discriminator domain, else null (out-of-domain / absent)", () => {
    expect(mapAssistantThreadRow({ id: "x", origin: "assistant-native", created_at: "", updated_at: "" }).origin).toBe("assistant-native");
    expect(mapAssistantThreadRow({ id: "x", origin: "bogus", created_at: "", updated_at: "" }).origin).toBeNull();
    expect(mapAssistantThreadRow({ id: "x", created_at: "", updated_at: "" }).origin).toBeNull();
  });

  it("maps project_id to null when absent (ambient/legacy thread)", () => {
    const t = mapAssistantThreadRow({ id: "th2", created_at: "2026-07-10T10:00:00.000Z", updated_at: "2026-07-10T10:00:00.000Z" });
    expect(t.projectId).toBeNull();
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
      projectId: "proj1",
    });
    expect(t.id).toBe("th1");
    const call = runPostgresQueriesSync.mock.calls[0][0];
    const q = call.queries[0];
    expect(q.text.toLowerCase()).toContain('insert into "app_test"."assistant_threads"');
    expect(q.text.toLowerCase()).toContain("returning");
    // [id, assistantUserId, ownerUserId, orgId, projectId, title, contextId]
    expect(q.values).toEqual(["th1", "au1", "u1", "org1", "proj1", null, null]);
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

// ---------------------------------------------------------------------------
// PR2 CUTOVER (cinatra#1037 P5.6 drop-history): structured read reconstruction,
// the pre-cutover content-presence exclusion predicate, and the pause/content
// store ops.
// ---------------------------------------------------------------------------

const baseThread: AssistantThread = {
  id: "th1",
  assistantUserId: null,
  ownerUserId: "u1",
  orgId: "org1",
  projectId: null,
  teamId: null,
  origin: "legacy-chat",
  title: "My chat",
  contextId: null,
  createdAt: "2026-07-10T10:00:00.000Z",
  updatedAt: "2026-07-10T12:00:00.000Z",
};

function turn(partial: Partial<AssistantTurn> & { id: string }): AssistantTurn {
  return {
    threadId: "th1",
    runId: null,
    assistantUserId: null,
    role: "assistant",
    status: "completed",
    content: null,
    createdAt: "2026-07-10T10:00:00.000Z",
    updatedAt: "2026-07-10T10:00:00.000Z",
    ...partial,
  };
}

describe("assembleThreadPayloadFromParts (pure reconstruction + exclusion)", () => {
  it("EXCLUDES a pre-cutover thread: null when no LEGACY-MIRROR turn has content", () => {
    // content-less mirror shadow minted before PR1 EXPAND
    expect(
      assembleThreadPayloadFromParts(baseThread, [turn({ id: "legacy:3:th1:m1", content: null })], [], null),
    ).toBeNull();
    // empty thread: no turns at all
    expect(assembleThreadPayloadFromParts(baseThread, [], [], null)).toBeNull();
  });

  it("SCOPES to legacy-mirror turns: runtime-native turns (bare id, run_id set) are excluded", () => {
    const legacyMsg = { id: "m1", role: "user", content: "hi" };
    const runtimeMsg = { id: "r1", role: "assistant", content: "runtime" };
    const payload = assembleThreadPayloadFromParts(
      baseThread,
      [
        // a runtime-native turn: bare UUID id + run_id present + content — MUST be ignored
        turn({ id: "9f1e-uuid", runId: "run-1", role: "assistant", content: runtimeMsg }),
        // the legacy-mirror /chat turn — the only faithful source
        turn({ id: "legacy:3:th1:m1", role: "user", content: legacyMsg }),
      ],
      [],
      null,
    );
    expect(payload!.messages).toEqual([legacyMsg]); // runtime turn NOT mixed in
  });

  it("reconstructs messages losslessly from turn.content in the given (ordinal) order", () => {
    const m1 = { id: "m1", role: "user", content: "hello", createdAt: "2026-07-10T10:00:00.000Z" };
    const m2 = { id: "m2", role: "assistant", content: "hi there", createdAt: "2026-07-10T10:01:00.000Z" };
    const payload = assembleThreadPayloadFromParts(
      baseThread,
      [turn({ id: "legacy:3:th1:m1", role: "user", content: m1 }), turn({ id: "legacy:3:th1:m2", content: m2 })],
      [],
      null,
    );
    expect(payload).not.toBeNull();
    expect(payload!.id).toBe("th1");
    expect(payload!.title).toBe("My chat");
    expect(payload!.ownerUserId).toBe("u1");
    expect(payload!.messages).toEqual([m1, m2]);
    expect(payload!.createdAt).toBe("2026-07-10T10:00:00.000Z");
    expect(payload!.updatedAt).toBe("2026-07-10T12:00:00.000Z");
  });

  it("skips content-less turns but keeps the thread when >=1 legacy turn has content", () => {
    const m2 = { id: "m2", role: "assistant", content: "hi" };
    const payload = assembleThreadPayloadFromParts(
      baseThread,
      [turn({ id: "legacy:3:th1:a", content: null }), turn({ id: "legacy:3:th1:b", content: m2 })],
      [],
      null,
    );
    expect(payload!.messages).toEqual([m2]);
  });

  it("carries the structured pause set through as pausedParticipants", () => {
    const m = { id: "m", role: "user", content: "x" };
    const payload = assembleThreadPayloadFromParts(baseThread, [turn({ id: "legacy:3:th1:b", content: m })], ["cinatra", "asst-9"], null);
    expect(payload!.pausedParticipants).toEqual(["cinatra", "asst-9"]);
  });

  it("reads durable render-state scalars back DIRECTLY (no derivation from mentions)", () => {
    const m = { id: "m", role: "user", content: "@a @b", mentions: [{ handle: "a", assistantUserId: "asst-a" }] };
    const scalars = { activeAssistantHandle: "beta", taggedAssistantUserIds: ["asst-a", "asst-b"], slackMode: true };
    const payload = assembleThreadPayloadFromParts(baseThread, [turn({ id: "legacy:3:th1:b", content: m })], [], scalars);
    // taken verbatim from the persisted scalars, NOT recomputed from mentions
    expect(payload!.activeAssistantHandle).toBe("beta");
    expect(payload!.taggedAssistantUserIds).toEqual(["asst-a", "asst-b"]);
    expect(payload!.slackMode).toBe(true);
  });

  it("omits render-state scalars entirely when none were persisted (scalars null)", () => {
    const m = { id: "m", role: "user", content: "just cinatra" };
    const payload = assembleThreadPayloadFromParts(baseThread, [turn({ id: "legacy:3:th1:b", content: m })], [], null);
    expect("activeAssistantHandle" in payload!).toBe(false);
    expect("taggedAssistantUserIds" in payload!).toBe(false);
    expect("slackMode" in payload!).toBe(false);
  });

  it("modeled fields overwrite any stale duplicate in scalars", () => {
    const m = { id: "m", role: "user", content: "x" };
    const scalars = { id: "STALE", title: "STALE", messages: ["STALE"] };
    const payload = assembleThreadPayloadFromParts(baseThread, [turn({ id: "legacy:3:th1:b", content: m })], [], scalars);
    expect(payload!.id).toBe("th1");
    expect(payload!.title).toBe("My chat");
    expect(payload!.messages).toEqual([m]);
  });

  it("includes projectId only when set", () => {
    const m = { id: "m", role: "user", content: "x" };
    const withProject = assembleThreadPayloadFromParts({ ...baseThread, projectId: "proj-9" }, [turn({ id: "legacy:3:th1:b", content: m })], [], null);
    expect(withProject!.projectId).toBe("proj-9");
    const withoutProject = assembleThreadPayloadFromParts(baseThread, [turn({ id: "legacy:3:th1:b", content: m })], [], null);
    expect("projectId" in withoutProject!).toBe(false);
  });

  it("includes teamId only when set (round-trips team ownership through re-save)", () => {
    const m = { id: "m", role: "user", content: "x" };
    const withTeam = assembleThreadPayloadFromParts({ ...baseThread, teamId: "team-7" }, [turn({ id: "legacy:3:th1:b", content: m })], [], null);
    expect(withTeam!.teamId).toBe("team-7");
    const withoutTeam = assembleThreadPayloadFromParts(baseThread, [turn({ id: "legacy:3:th1:b", content: m })], [], null);
    expect("teamId" in withoutTeam!).toBe(false);
  });
});

describe("listPausedParticipants", () => {
  beforeEach(() => runPostgresQueriesSync.mockReset());
  it("reads participant ids for a thread", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [{ participant_id: "cinatra" }, { participant_id: "asst-9" }] }]);
    expect(listPausedParticipants("th1")).toEqual(["cinatra", "asst-9"]);
    const q = runPostgresQueriesSync.mock.calls[0][0].queries[0];
    expect(q.text).toContain("assistant_thread_pause_state");
    expect(q.values).toEqual(["th1"]);
  });
  it("returns [] when none", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [] }]);
    expect(listPausedParticipants("th1")).toEqual([]);
  });
});

describe("listAssistantThreadIdsWithDurableContent (exclusion predicate)", () => {
  beforeEach(() => runPostgresQueriesSync.mockReset());
  it("returns the set of thread ids with a legacy-mirror content turn (scoped)", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [{ thread_id: "th1" }, { thread_id: "th3" }] }]);
    const set = listAssistantThreadIdsWithDurableContent();
    expect(set.has("th1")).toBe(true);
    expect(set.has("th3")).toBe(true);
    expect(set.has("th2")).toBe(false);
    const q = runPostgresQueriesSync.mock.calls[0][0].queries[0];
    expect(q.text).toContain("content IS NOT NULL");
    expect(q.text).toContain("run_id IS NULL");
    expect(q.text).toContain("id LIKE 'legacy:%'");
  });
});

describe("reconstructThreadPayload (single snapshot-consistent read)", () => {
  beforeEach(() => runPostgresQueriesSync.mockReset());

  it("reads all parts in ONE repeatable-read transaction", () => {
    const msg = { id: "m1", role: "user", content: "hi" };
    runPostgresQueriesSync.mockReturnValue([
      { rows: [] }, // SET TRANSACTION ISOLATION LEVEL REPEATABLE READ
      { rows: [{ id: "th1", owner_user_id: "u1", org_id: "org1", project_id: "proj-9", scalars: { slackMode: true }, title: "T", created_at: "2026-07-10T10:00:00.000Z", updated_at: "2026-07-10T11:00:00.000Z" }] },
      { rows: [{ id: "legacy:3:th1:m1", thread_id: "th1", run_id: null, role: "user", status: "completed", content: msg, created_at: "2026-07-10T10:00:00.000Z", updated_at: "2026-07-10T10:00:00.000Z" }] },
      { rows: [{ participant_id: "asst-9" }] },
    ]);
    const payload = reconstructThreadPayload("th1");
    expect(runPostgresQueriesSync).toHaveBeenCalledTimes(1);
    const call = runPostgresQueriesSync.mock.calls[0][0];
    expect(call.transaction).toBe(true);
    expect(call.queries[0].text).toContain("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    expect(call.queries[2].text).toContain("ORDER BY ordinal NULLS LAST, created_at, id");
    expect(payload).not.toBeNull();
    expect(payload!.messages).toEqual([msg]);
    expect(payload!.pausedParticipants).toEqual(["asst-9"]);
    expect(payload!.title).toBe("T");
    expect(payload!.projectId).toBe("proj-9");
    expect(payload!.slackMode).toBe(true); // scalars read back directly
  });

  it("returns null when the thread row is absent", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }]);
    expect(reconstructThreadPayload("nope")).toBeNull();
  });

  it("returns null for a pre-cutover thread (present row, content-less turns)", () => {
    runPostgresQueriesSync.mockReturnValue([
      { rows: [] },
      { rows: [{ id: "th1", title: "T", created_at: "2026-07-10T10:00:00.000Z", updated_at: "2026-07-10T10:00:00.000Z" }] },
      { rows: [] }, // no legacy content turns survive the WHERE scope
      { rows: [] },
    ]);
    expect(reconstructThreadPayload("th1")).toBeNull();
  });
});
