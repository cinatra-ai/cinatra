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
  bindAssistantThread,
  readAssistantThreadBinding,
  threadBindingOf,
  getAssistantThreadByIdInContainer,
  ensureThreadSlug,
  readAssistantTurnActivityByRunId,
} from "../assistant-thread-store";
import type { AssistantThread, AssistantTurn } from "../assistant-thread-store";

describe("pure row mappers", () => {
  it("maps an assistant_threads row (nulls preserved, dates → ISO, binding carried)", () => {
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
      assistant_package: "@cinatra-ai/wordpress-assistant",
      instance_id: "inst-42",
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
      assistantPackage: "@cinatra-ai/wordpress-assistant",
      instanceId: "inst-42",
      titleSlug: null,
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

  it("an unbound thread maps the binding columns to null (AC#4)", () => {
    const t = mapAssistantThreadRow({
      id: "th2",
      assistant_user_id: null,
      owner_user_id: "u1",
      org_id: null,
      title: null,
      context_id: null,
      // assistant_package / instance_id absent → null
      created_at: "2026-07-10T10:00:00.000Z",
      updated_at: "2026-07-10T10:00:00.000Z",
    });
    expect(t.assistantPackage).toBeNull();
    expect(t.instanceId).toBeNull();
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
            assistant_package: null,
            instance_id: null,
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
    // [id, assistantUserId, ownerUserId, orgId, projectId, title, contextId, assistantPackage, instanceId, titleSlug]
    // Binding columns default to null at creation (seeded later by the W3 route);
    // origin is stamped as the SQL literal 'assistant-native', not a bound param.
    // A titleless create defers the slug → title_slug ($10) is null (AC#2).
    expect(q.values).toEqual(["th1", "au1", "u1", "org1", "proj1", null, null, null, null, null]);
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
  assistantPackage: null,
  instanceId: null,
  titleSlug: null,
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

  it("SCOPES to legacy-mirror turns: a run-bound turn in another representation is excluded", () => {
    const legacyMsg = { id: "m1", role: "user", content: "hi" };
    const runtimeMsg = { id: "r1", role: "assistant", content: "runtime" };
    const payload = assembleThreadPayloadFromParts(
      baseThread,
      [
        // A run-bound turn whose content is NOT the sink's `assistant-turn-v1`
        // durable object. The S9j fold-in (cinatra#2823) reads exactly that one
        // format and nothing else, so a foreign representation is still ignored.
        turn({ id: "9f1e-uuid", runId: "run-1", role: "assistant", content: runtimeMsg }),
        // the legacy-mirror /chat turn — the spine
        turn({ id: "legacy:3:th1:m1", role: "user", content: legacyMsg }),
      ],
      [],
      null,
    );
    expect(payload!.messages).toEqual([legacyMsg]); // runtime turn NOT mixed in
  });

  // ── the S9j lifecycle fold-in (cinatra#2823) ──────────────────────────────
  // The rule and every narrowing in it are stated on `assembleThreadPayloadFromParts`.
  // These are the pure arms; the end-to-end proof is the Postgres contract tier
  // (`durable-lifecycle-reload-contract.integration.test.ts`), which drives the
  // real sink into the real store and mounts the real view on what comes back.

  /** A durable `assistant-turn-v1` content object, as the sink writes it. */
  function durableTurnContent(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      format: "assistant-turn-v1",
      role: "assistant",
      content: "here it is",
      parts: [
        { type: "text", text: "here it is" },
        { type: "tool_call", id: "call-1", name: "artifact_review_gate_render", serverLabel: "cinatra" },
        { type: "tool_result", id: "call-1", name: "artifact_review_gate_render", resultLabel: "ok" },
      ],
      ...over,
    };
  }

  const REVIEW_VIEW = { viewType: "artifact_review_gate", schemaVersion: 1, ref: "gate-ref-1" };

  it("INERT for a run-bound turn carrying no lifecycle render state", () => {
    const legacyMsg = { id: "m1", role: "user", content: "hi" };
    const payload = assembleThreadPayloadFromParts(
      baseThread,
      [
        turn({ id: "9f1e-uuid", runId: "run-1", content: durableTurnContent() }),
        turn({ id: "legacy:3:th1:m1", role: "user", content: legacyMsg }),
      ],
      [],
      null,
    );
    // No view, no pinned run — nothing for the fold-in to repair, so the
    // transcript is byte-identical to what it was before the fold-in existed.
    expect(payload!.messages).toEqual([legacyMsg]);
  });

  it("APPENDS a run-bound lifecycle turn the spine never received", () => {
    const legacyMsg = { id: "m1", role: "user", content: "hi" };
    const payload = assembleThreadPayloadFromParts(
      baseThread,
      [
        turn({
          id: "9f1e-uuid",
          runId: "run-1",
          content: durableTurnContent({ dataParts: [REVIEW_VIEW] }),
        }),
        turn({ id: "legacy:3:th1:m1", role: "user", content: legacyMsg }),
      ],
      [],
      null,
    );
    expect(payload!.messages).toHaveLength(2);
    const assistant = (payload!.messages as Record<string, unknown>[])[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.id).toBe("9f1e-uuid");
    expect(assistant.dataParts).toEqual([REVIEW_VIEW]);
    expect(assistant.parts).toEqual([
      { kind: "text", content: "here it is" },
      {
        kind: "tool_call",
        id: "call-1",
        name: "artifact_review_gate_render",
        status: "completed",
        serverLabel: "cinatra",
        resultLabel: "ok",
      },
    ]);
  });

  it("APPENDS run-bound turns in created_at order, not query order", () => {
    const payload = assembleThreadPayloadFromParts(
      baseThread,
      [
        turn({
          id: "turn-late",
          runId: "run-2",
          createdAt: "2026-07-10T10:05:00.000Z",
          content: durableTurnContent({
            parts: [{ type: "tool_call", id: "call-late", name: "verification_record_render" }],
            dataParts: [{ viewType: "verification_summary", schemaVersion: 1, ref: "late" }],
          }),
        }),
        turn({
          id: "turn-early",
          runId: "run-1",
          createdAt: "2026-07-10T10:01:00.000Z",
          content: durableTurnContent({
            parts: [{ type: "tool_call", id: "call-early", name: "artifact_review_gate_render" }],
            dataParts: [{ viewType: "artifact_review_gate", schemaVersion: 1, ref: "early" }],
          }),
        }),
        turn({ id: "legacy:3:th1:m1", role: "user", content: { id: "m1", role: "user", content: "hi" } }),
      ],
      [],
      null,
    );
    const refs = (payload!.messages as Record<string, unknown>[])
      .filter((m) => m.role === "assistant")
      .map((m) => ((m.dataParts as Record<string, unknown>[])[0]).ref);
    expect(refs).toEqual(["early", "late"]);
  });

  it("REPAIRS rather than duplicates a spine turn that shares a tool-call id", () => {
    const legacyMsg = { id: "m1", role: "user", content: "hi" };
    // The client's save DID land for this turn — but without the view it dropped.
    const spineAssistant = {
      id: "a1",
      role: "assistant",
      content: "here it is",
      parts: [{ kind: "tool_call", id: "call-1", name: "artifact_review_gate_render", status: "completed" }],
    };
    const payload = assembleThreadPayloadFromParts(
      baseThread,
      [
        turn({
          id: "9f1e-uuid",
          runId: "run-1",
          content: durableTurnContent({ dataParts: [REVIEW_VIEW] }),
        }),
        turn({ id: "legacy:3:th1:m1", role: "user", content: legacyMsg }),
        turn({ id: "legacy:3:th1:a1", content: spineAssistant }),
      ],
      [],
      null,
    );
    expect(payload!.messages).toHaveLength(2); // NOT three — the turn is not doubled
    const assistant = (payload!.messages as Record<string, unknown>[])[1];
    expect(assistant.id).toBe("a1"); // the reader's own message identity survives
    expect(assistant.dataParts).toEqual([REVIEW_VIEW]);
  });

  it("leaves the CALLER's own message objects untouched (copy-on-write)", () => {
    const spineAssistant = {
      id: "a1",
      role: "assistant",
      content: "here it is",
      parts: [{ kind: "tool_call", id: "call-1", name: "artifact_review_gate_render", status: "completed" }],
    };
    const before = JSON.parse(JSON.stringify(spineAssistant));
    const payload = assembleThreadPayloadFromParts(
      baseThread,
      [
        turn({ id: "9f1e-uuid", runId: "run-1", content: durableTurnContent({ dataParts: [REVIEW_VIEW] }) }),
        turn({ id: "legacy:3:th1:a1", content: spineAssistant }),
      ],
      [],
      null,
    );
    // The repair is visible in the payload...
    expect((payload!.messages as Record<string, unknown>[])[0].dataParts).toEqual([REVIEW_VIEW]);
    // ...and NOT written back onto the object the caller still holds.
    expect(spineAssistant).toEqual(before);
  });

  it("NEVER re-adds a view the spine already draws at its PRODUCING SLOT", () => {
    // Exactly the shape the S9i reducer produces for a SLOTTED card
    // (cinatra#2827): the view is folded onto the tool_call that produced it and
    // the turn-level `dataParts` key is never created. The absent key is NOT a
    // dropped save here — it is the normal post-S9i shape — so the fold-in must
    // not "repair" it into a second, turn-level copy of a card already on screen.
    const spineAssistant = {
      id: "a1",
      role: "assistant",
      content: "here it is",
      parts: [
        {
          kind: "tool_call",
          id: "call-1",
          name: "artifact_review_gate_render",
          status: "completed",
          views: [{ ...REVIEW_VIEW }],
        },
      ],
    };
    const payload = assembleThreadPayloadFromParts(
      baseThread,
      [
        turn({ id: "9f1e-uuid", runId: "run-1", content: durableTurnContent({ dataParts: [REVIEW_VIEW] }) }),
        turn({ id: "legacy:3:th1:a1", content: spineAssistant }),
      ],
      [],
      null,
    );
    const messages = payload!.messages as Record<string, unknown>[];
    expect(messages).toHaveLength(1);
    // Nothing was owed — the card is already drawn at its slot — so the reader's
    // own message object comes back untouched, and the transcript draws the card
    // ONCE (S9i's invariant), at the step that produced it.
    expect(messages[0]).toBe(spineAssistant);
    expect(messages[0].dataParts).toBeUndefined();
  });

  it("restores ONLY the views no slot already draws, when a turn carries both", () => {
    // Two cards on the durable row; the spine draws one of them at its slot and
    // lost the other. The unseen one is owed; the seen one is not.
    const UNSLOTTED_VIEW = { viewType: "artifact_review_gate", schemaVersion: 1, ref: "gate-ref-2" };
    const spineAssistant = {
      id: "a1",
      role: "assistant",
      content: "here it is",
      parts: [
        {
          kind: "tool_call",
          id: "call-1",
          name: "artifact_review_gate_render",
          status: "completed",
          views: [{ ...REVIEW_VIEW }],
        },
      ],
    };
    const payload = assembleThreadPayloadFromParts(
      baseThread,
      [
        turn({
          id: "9f1e-uuid",
          runId: "run-1",
          content: durableTurnContent({ dataParts: [REVIEW_VIEW, UNSLOTTED_VIEW] }),
        }),
        turn({ id: "legacy:3:th1:a1", content: spineAssistant }),
      ],
      [],
      null,
    );
    const messages = payload!.messages as Record<string, unknown>[];
    // The slotted one is NOT duplicated into the turn-level list; the lost one is.
    expect(messages[0].dataParts).toEqual([UNSLOTTED_VIEW]);
  });

  it("a spine whose SLOTTED cards are all different does not claim the durable turn", () => {
    // `contradictsDurableTurn` reads the spine's views to catch "this message is
    // showing a different card entirely". Post-S9i those views can live only at
    // the slots, and a reader that asked `dataParts` alone would call this spine
    // SILENT — and silence contradicts nothing, so the run pin below would have
    // been folded onto a message that is demonstrably another turn.
    const spineAssistant = {
      id: "a1",
      role: "assistant",
      content: "a different turn",
      parts: [
        {
          kind: "tool_call",
          id: "call-1",
          name: "artifact_review_gate_render",
          status: "completed",
          views: [{ viewType: "artifact_review_gate", schemaVersion: 1, ref: "SOME-OTHER-ref" }],
        },
      ],
    };
    const before = JSON.parse(JSON.stringify(spineAssistant));
    const payload = assembleThreadPayloadFromParts(
      baseThread,
      [
        turn({ id: "9f1e-uuid", runId: "run-1", content: durableTurnContent({ dataParts: [REVIEW_VIEW] }) }),
        turn({ id: "legacy:3:th1:a1", content: spineAssistant }),
      ],
      [],
      null,
    );
    const messages = payload!.messages as Record<string, unknown>[];
    // The contradiction is seen: the durable turn is placed as its OWN message
    // rather than repairing a spine message that is showing another card.
    expect(messages).toHaveLength(2);
    expect(spineAssistant).toEqual(before);
  });

  it("NEVER overwrites a view the spine already carries", () => {
    // The reader's save DID land with the view on it — the SAME view the server
    // recorded, because both sides read it off the same wire.
    const spineAssistant = {
      id: "a1",
      role: "assistant",
      content: "here it is",
      parts: [{ kind: "tool_call", id: "call-1", name: "artifact_review_gate_render", status: "completed" }],
      dataParts: [{ ...REVIEW_VIEW }],
    };
    const payload = assembleThreadPayloadFromParts(
      baseThread,
      [
        turn({ id: "9f1e-uuid", runId: "run-1", content: durableTurnContent({ dataParts: [REVIEW_VIEW] }) }),
        turn({ id: "legacy:3:th1:a1", content: spineAssistant }),
      ],
      [],
      null,
    );
    const messages = payload!.messages as Record<string, unknown>[];
    expect(messages).toHaveLength(1); // repaired-or-left-alone, never doubled
    // Nothing was owed, so the reader's own message object comes back untouched.
    expect(messages[0]).toBe(spineAssistant);
  });

  it("PINS a run on a spine tool call that lost it, and leaves an already-pinned one alone", () => {
    const durable = durableTurnContent({
      parts: [
        { type: "tool_call", id: "call-1", name: "agent_run" },
        { type: "tool_result", id: "call-1", name: "agent_run", result: "{}" },
        { type: "tool_call", id: "call-2", name: "agent_run" },
      ],
      dataParts: [
        { kind: "agent_run", toolCallId: "call-1", runId: "run-A" },
        { kind: "agent_run", toolCallId: "call-2", runId: "run-B" },
      ],
    });
    // call-2 kept its pin through the save; call-1's was dropped. The pin the
    // reader kept AGREES with the server's — both came off the same wire, and a
    // pin that disagreed would mean this is not the same turn at all (below).
    const alreadyPinned = {
      kind: "tool_call",
      id: "call-2",
      name: "agent_run",
      status: "completed",
      runId: "run-B",
    };
    const spineAssistant = {
      id: "a1",
      role: "assistant",
      content: "here it is",
      parts: [{ kind: "tool_call", id: "call-1", name: "agent_run", status: "completed" }, alreadyPinned],
    };
    const payload = assembleThreadPayloadFromParts(
      baseThread,
      [
        turn({ id: "9f1e-uuid", runId: "run-1", content: durable }),
        turn({ id: "legacy:3:th1:a1", content: spineAssistant }),
      ],
      [],
      null,
    );
    const parts = (payload!.messages as Record<string, unknown>[])[0].parts as Record<string, unknown>[];
    expect(parts[0].runId).toBe("run-A"); // filled in
    // The reader's own state wins: the pinned part is not even rewritten.
    expect(parts[1]).toBe(alreadyPinned);
  });

  // ── F1: the tool-call match must corroborate before it repairs ────────────
  // The spine side of a shared tool-call id is content the CLIENT wrote. A bare
  // id hit is a claim; these three arms are the corroboration it has to pass.

  it("REFUSES the repair when TWO spine messages claim the same tool-call id", () => {
    const claimant = (id: string) => ({
      id,
      role: "assistant",
      content: "here it is",
      parts: [{ kind: "tool_call", id: "call-1", name: "artifact_review_gate_render", status: "completed" }],
    });
    const first = claimant("a1");
    const second = claimant("a2");
    const payload = assembleThreadPayloadFromParts(
      baseThread,
      [
        turn({ id: "9f1e-uuid", runId: "run-1", content: durableTurnContent({ dataParts: [REVIEW_VIEW] }) }),
        turn({ id: "legacy:3:th1:a1", content: first }),
        turn({ id: "legacy:3:th1:a2", content: second }),
      ],
      [],
      null,
    );
    const messages = payload!.messages as Record<string, unknown>[];
    // NEITHER claimant is repaired — picking one would be picking by iteration
    // order — and the server's own record is folded in rather than dropped.
    expect(messages).toHaveLength(3);
    expect(messages[0]).toBe(first);
    expect(messages[1]).toBe(second);
    expect(messages[2].id).toBe("9f1e-uuid");
    expect(messages[2].dataParts).toEqual([REVIEW_VIEW]);
  });

  it("REFUSES the repair when the covering spine message pins a DIFFERENT run on the shared call", () => {
    const durable = durableTurnContent({
      parts: [
        { type: "tool_call", id: "call-1", name: "agent_run" },
        { type: "tool_result", id: "call-1", name: "agent_run", result: "{}" },
        { type: "tool_call", id: "call-2", name: "agent_run" },
      ],
      dataParts: [
        { kind: "agent_run", toolCallId: "call-1", runId: "run-A" },
        { kind: "agent_run", toolCallId: "call-2", runId: "run-B" },
      ],
    });
    const spineAssistant = {
      id: "a1",
      role: "assistant",
      content: "here it is",
      parts: [
        { kind: "tool_call", id: "call-1", name: "agent_run", status: "completed" },
        // The same server-minted call, pinned to a run the server never recorded
        // for it: whatever this message is, it is not this turn.
        { kind: "tool_call", id: "call-2", name: "agent_run", status: "completed", runId: "some-other-run" },
      ],
    };
    const payload = assembleThreadPayloadFromParts(
      baseThread,
      [
        turn({ id: "9f1e-uuid", runId: "run-1", content: durable }),
        turn({ id: "legacy:3:th1:a1", content: spineAssistant }),
      ],
      [],
      null,
    );
    const messages = payload!.messages as Record<string, unknown>[];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(spineAssistant); // call-1 NOT pinned from this turn
    const folded = messages[1].parts as Record<string, unknown>[];
    expect(messages[1].id).toBe("9f1e-uuid"); // the server's record survives
    expect(folded.find((p) => p.id === "call-1")!.runId).toBe("run-A");
  });

  it("REFUSES the repair when the covering spine message carries a DISJOINT view ref", () => {
    const spineView = { viewType: "artifact_review_gate", schemaVersion: 1, ref: "a-different-card" };
    const spineAssistant = {
      id: "a1",
      role: "assistant",
      content: "here it is",
      parts: [
        { kind: "tool_call", id: "call-1", name: "artifact_review_gate_render", status: "completed" },
        { kind: "tool_call", id: "call-9", name: "agent_run", status: "completed" },
      ],
      dataParts: [spineView],
    };
    const durable = durableTurnContent({
      parts: [
        { type: "tool_call", id: "call-1", name: "artifact_review_gate_render" },
        { type: "tool_result", id: "call-1", name: "artifact_review_gate_render" },
        { type: "tool_call", id: "call-9", name: "agent_run" },
      ],
      dataParts: [REVIEW_VIEW, { kind: "agent_run", toolCallId: "call-9", runId: "run-A" }],
    });
    const payload = assembleThreadPayloadFromParts(
      baseThread,
      [
        turn({ id: "9f1e-uuid", runId: "run-1", content: durable }),
        turn({ id: "legacy:3:th1:a1", content: spineAssistant }),
      ],
      [],
      null,
    );
    const messages = payload!.messages as Record<string, unknown>[];
    expect(messages).toHaveLength(2);
    // The reader's message is untouched — not repaired, and NOT run-pinned
    // either: a refused match refuses the whole repair, not just the views.
    expect(messages[0]).toBe(spineAssistant);
    expect(messages[1].dataParts).toEqual([REVIEW_VIEW]);
  });

  // ── F2: position by SERVER TIME, because the spine is not always a prefix ──

  it("places an uncovered turn by SERVER TIME when the spine is NOT a prefix (stale save)", () => {
    // A stale tab posted a whole transcript that omitted the assistant turn but
    // carried a LATER user message; the mirror reconcile deleted the omitted
    // row. The spine is now [10:00, 10:10] with a 10:05 turn missing from it.
    const m1 = { id: "m1", role: "user", content: "make me a gate" };
    const m3 = { id: "m3", role: "user", content: "and now something else" };
    const payload = assembleThreadPayloadFromParts(
      baseThread,
      [
        turn({
          id: "9f1e-uuid",
          runId: "run-1",
          createdAt: "2026-07-10T10:05:00.000Z",
          content: durableTurnContent({ dataParts: [REVIEW_VIEW] }),
        }),
        turn({ id: "legacy:3:th1:m1", role: "user", createdAt: "2026-07-10T10:00:00.000Z", content: m1 }),
        turn({ id: "legacy:3:th1:m3", role: "user", createdAt: "2026-07-10T10:10:00.000Z", content: m3 }),
      ],
      [],
      null,
    );
    const messages = payload!.messages as Record<string, unknown>[];
    // Its real position, NOT the tail: the turn happened before m3 and the
    // server's own clock is the only record that still says so.
    expect(messages.map((m) => m.id)).toEqual(["m1", "9f1e-uuid", "m3"]);
  });

  it("places an uncovered turn that PRECEDES the whole spine at the head", () => {
    const m9 = { id: "m9", role: "user", content: "later" };
    const payload = assembleThreadPayloadFromParts(
      baseThread,
      [
        turn({
          id: "9f1e-uuid",
          runId: "run-1",
          createdAt: "2026-07-10T09:00:00.000Z",
          content: durableTurnContent({ dataParts: [REVIEW_VIEW] }),
        }),
        turn({ id: "legacy:3:th1:m9", role: "user", createdAt: "2026-07-10T10:00:00.000Z", content: m9 }),
      ],
      [],
      null,
    );
    expect((payload!.messages as Record<string, unknown>[]).map((m) => m.id)).toEqual(["9f1e-uuid", "m9"]);
  });

  // ── F3: an explicitly EMPTY dataParts is an answer, not a gap ─────────────

  it("leaves an explicitly EMPTY dataParts alone (absent is repairable; empty is the reader's answer)", () => {
    const spineAssistant = {
      id: "a1",
      role: "assistant",
      content: "here it is",
      parts: [{ kind: "tool_call", id: "call-1", name: "artifact_review_gate_render", status: "completed" }],
      dataParts: [] as Record<string, unknown>[],
    };
    const payload = assembleThreadPayloadFromParts(
      baseThread,
      [
        turn({ id: "9f1e-uuid", runId: "run-1", content: durableTurnContent({ dataParts: [REVIEW_VIEW] }) }),
        turn({ id: "legacy:3:th1:a1", content: spineAssistant }),
      ],
      [],
      null,
    );
    const messages = payload!.messages as Record<string, unknown>[];
    expect(messages).toHaveLength(1);
    expect(messages[0].dataParts).toEqual([]); // reader wins — nothing was owed
    expect(messages[0]).toBe(spineAssistant);
  });

  // ── F5: two rows for one turn elect the LATEST, deliberately ─────────────

  it("ELECTS the LATEST of two durable rows covering the same spine message", () => {
    const spineAssistant = {
      id: "a1",
      role: "assistant",
      content: "here it is",
      parts: [{ kind: "tool_call", id: "call-1", name: "artifact_review_gate_render", status: "completed" }],
    };
    const row = (id: string, createdAt: string, ref: string) =>
      turn({
        id,
        runId: "run-1",
        createdAt,
        content: durableTurnContent({
          dataParts: [{ viewType: "artifact_review_gate", schemaVersion: 1, ref }],
        }),
      });
    const payload = assembleThreadPayloadFromParts(
      baseThread,
      [
        // Query order deliberately puts the EARLIER row second, so a fold-in
        // that elected by iteration order would still pick "earlier" here.
        row("turn-late", "2026-07-10T10:09:00.000Z", "the-newest-server-record"),
        row("turn-early", "2026-07-10T10:01:00.000Z", "an-older-server-record"),
        turn({ id: "legacy:3:th1:a1", content: spineAssistant }),
      ],
      [],
      null,
    );
    const messages = payload!.messages as Record<string, unknown>[];
    expect(messages).toHaveLength(1); // one turn, one repair — not two
    expect(messages[0].dataParts).toEqual([
      { viewType: "artifact_review_gate", schemaVersion: 1, ref: "the-newest-server-record" },
    ]);
  });

  it("ELECTS the LATEST of two durable rows the spine does not carry, folding in ONE", () => {
    const m1 = { id: "m1", role: "user", content: "hi" };
    const row = (id: string, createdAt: string, ref: string) =>
      turn({
        id,
        runId: "run-1",
        createdAt,
        content: durableTurnContent({
          dataParts: [{ viewType: "artifact_review_gate", schemaVersion: 1, ref }],
        }),
      });
    const payload = assembleThreadPayloadFromParts(
      baseThread,
      [
        row("turn-late", "2026-07-10T10:09:00.000Z", "the-newest-server-record"),
        row("turn-early", "2026-07-10T10:01:00.000Z", "an-older-server-record"),
        turn({ id: "legacy:3:th1:m1", role: "user", content: m1 }),
      ],
      [],
      null,
    );
    const messages = payload!.messages as Record<string, unknown>[];
    expect(messages).toHaveLength(2); // the turn appears ONCE, not twice
    expect(messages[1].id).toBe("turn-late");
    expect(messages[1].dataParts).toEqual([
      { viewType: "artifact_review_gate", schemaVersion: 1, ref: "the-newest-server-record" },
    ]);
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

// cinatra#1875 W2, AC#4 — the canonical thread binding {assistantPackage,
// instanceId?} round-trips through the store seam the W1 registry reader supports.
describe("thread binding (AC#4)", () => {
  beforeEach(() => runPostgresQueriesSync.mockReset());

  function threadRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      id: "th1",
      assistant_user_id: null,
      owner_user_id: "u1",
      org_id: "org1",
      title: null,
      context_id: null,
      assistant_package: null,
      instance_id: null,
      created_at: "2026-07-10T10:00:00.000Z",
      updated_at: "2026-07-10T10:00:00.000Z",
      ...over,
    };
  }

  it("threadBindingOf extracts the binding, or null when unbound", () => {
    const bound = mapAssistantThreadRow(
      threadRow({ assistant_package: "@cinatra-ai/drupal-assistant", instance_id: "inst-9" }),
    );
    expect(threadBindingOf(bound)).toEqual({
      assistantPackage: "@cinatra-ai/drupal-assistant",
      instanceId: "inst-9",
    });
    // A package with no instance scope: instanceId null.
    const pkgOnly = mapAssistantThreadRow(
      threadRow({ assistant_package: "@cinatra-ai/cinatra-assistant", instance_id: null }),
    );
    expect(threadBindingOf(pkgOnly)).toEqual({
      assistantPackage: "@cinatra-ai/cinatra-assistant",
      instanceId: null,
    });
    // Unbound thread → null (implicit-@cinatra default).
    expect(threadBindingOf(mapAssistantThreadRow(threadRow()))).toBeNull();
  });

  it("bindAssistantThread writes assistant_package + instance_id and bumps updated_at", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [] }]);
    bindAssistantThread("th1", {
      assistantPackage: "@cinatra-ai/wordpress-assistant",
      instanceId: "inst-42",
    });
    const q = runPostgresQueriesSync.mock.calls[0][0].queries[0];
    expect(q.text.toLowerCase()).toContain('update "app_test"."assistant_threads"');
    expect(q.text).toContain("assistant_package = $1");
    expect(q.text).toContain("instance_id = $2");
    expect(q.text).toContain("updated_at = now()");
    expect(q.text).toContain("WHERE id = $3");
    expect(q.values).toEqual(["@cinatra-ai/wordpress-assistant", "inst-42", "th1"]);
  });

  it("bindAssistantThread clears the instance scope to null when instanceId omitted", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [] }]);
    bindAssistantThread("th1", { assistantPackage: "@cinatra-ai/cinatra-assistant" });
    const q = runPostgresQueriesSync.mock.calls[0][0].queries[0];
    expect(q.values).toEqual(["@cinatra-ai/cinatra-assistant", null, "th1"]);
  });

  it("bind → read round-trips the binding (write then read the persisted row)", () => {
    // Write.
    runPostgresQueriesSync.mockReturnValueOnce([{ rows: [] }]);
    bindAssistantThread("th1", {
      assistantPackage: "@cinatra-ai/wordpress-assistant",
      instanceId: "inst-42",
    });
    // Read back the row the bind persisted (the SELECT returns the bound columns).
    runPostgresQueriesSync.mockReturnValueOnce([
      {
        rows: [
          threadRow({ assistant_package: "@cinatra-ai/wordpress-assistant", instance_id: "inst-42" }),
        ],
      },
    ]);
    const binding = readAssistantThreadBinding("th1");
    expect(binding).toEqual({
      assistantPackage: "@cinatra-ai/wordpress-assistant",
      instanceId: "inst-42",
    });
  });

  it("readAssistantThreadBinding returns null for an unbound thread", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [threadRow()] }]);
    expect(readAssistantThreadBinding("th1")).toBeNull();
  });

  it("readAssistantThreadBinding returns null for an absent thread", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [] }]);
    expect(readAssistantThreadBinding("nope")).toBeNull();
  });

  it("createAssistantThread can seed the binding at creation", () => {
    runPostgresQueriesSync.mockReturnValue([
      {
        rows: [
          threadRow({ assistant_package: "@cinatra-ai/drupal-assistant", instance_id: "inst-7" }),
        ],
      },
    ]);
    const t: AssistantThread = createAssistantThread({
      id: "th1",
      ownerUserId: "u1",
      orgId: "org1",
      assistantPackage: "@cinatra-ai/drupal-assistant",
      instanceId: "inst-7",
    });
    expect(t.assistantPackage).toBe("@cinatra-ai/drupal-assistant");
    expect(t.instanceId).toBe("inst-7");
    const q = runPostgresQueriesSync.mock.calls[0][0].queries[0];
    // [id, assistantUserId, ownerUserId, orgId, projectId, title, contextId, assistantPackage, instanceId, titleSlug]
    expect(q.values).toEqual([
      "th1",
      null,
      "u1",
      "org1",
      null,
      null,
      null,
      "@cinatra-ai/drupal-assistant",
      "inst-7",
      null,
    ]);
  });
});

// cinatra#2562: the /chat route guard's pre-slug fallback — a thread is
// addressable by its stable id, scoped to the EXACT container, before its
// title-slug mints.
describe("getAssistantThreadByIdInContainer (cinatra#2562)", () => {
  beforeEach(() => runPostgresQueriesSync.mockReset());

  const UUID = "11111111-1111-1111-1111-111111111111";
  const row = (over: Record<string, unknown> = {}) => ({
    id: UUID,
    assistant_user_id: null,
    owner_user_id: "u1",
    org_id: "org1",
    title: "Weekly sync",
    context_id: null,
    assistant_package: "@cinatra-ai/cinatra-assistant",
    instance_id: null,
    title_slug: null,
    created_at: "2026-07-10T10:00:00.000Z",
    updated_at: "2026-07-10T10:00:00.000Z",
    ...over,
  });

  it("returns null for a non-UUID-shaped value WITHOUT hitting the DB", () => {
    const t = getAssistantThreadByIdInContainer("@cinatra-ai/cinatra-assistant", null, "not-a-uuid");
    expect(t).toBeNull();
    expect(runPostgresQueriesSync).not.toHaveBeenCalled();
  });

  it("returns the thread when the id resolves inside the EXACT container", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [row()] }]);
    const t = getAssistantThreadByIdInContainer("@cinatra-ai/cinatra-assistant", null, UUID);
    expect(t?.id).toBe(UUID);
  });

  it("returns null when the thread belongs to a DIFFERENT assistant package", () => {
    runPostgresQueriesSync.mockReturnValue([
      { rows: [row({ assistant_package: "@cinatra-ai/wordpress-assistant" })] },
    ]);
    const t = getAssistantThreadByIdInContainer("@cinatra-ai/cinatra-assistant", null, UUID);
    expect(t).toBeNull();
  });

  it("returns null when the thread belongs to a DIFFERENT instance", () => {
    runPostgresQueriesSync.mockReturnValue([
      { rows: [row({ assistant_package: "@cinatra-ai/wordpress-assistant", instance_id: "site-9" })] },
    ]);
    const t = getAssistantThreadByIdInContainer("@cinatra-ai/wordpress-assistant", "site-A", UUID);
    expect(t).toBeNull();
  });

  it("returns null when no thread carries the id", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [] }]);
    const t = getAssistantThreadByIdInContainer("@cinatra-ai/cinatra-assistant", null, UUID);
    expect(t).toBeNull();
  });

  it("matches an unbound (null/null) container exactly", () => {
    runPostgresQueriesSync.mockReturnValue([
      { rows: [row({ assistant_package: null, instance_id: null })] },
    ]);
    expect(getAssistantThreadByIdInContainer(null, null, UUID)?.id).toBe(UUID);
  });
});

// cinatra#2562 codex round-2 finding: the id/slug namespace collision is
// closed at the SOURCE — no title-slug the allocator mints is ever
// UUID-shaped, so a UUID-shaped route segment can only ever mean an id.
describe("title-slug allocator excludes UUID-shaped candidates (cinatra#2562)", () => {
  beforeEach(() => runPostgresQueriesSync.mockReset());

  const UUID_TITLE = "33333333-3333-3333-3333-333333333333";
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it("createAssistantThread skips a UUID-shaped slug candidate — the mint retries a suffixed one instead", () => {
    // slugifyTitle(UUID_TITLE) is already all-lowercase-hex-and-hyphens, so it
    // normalizes to the SAME string — the bare candidate IS UUID-shaped and
    // must be rejected before any INSERT is attempted for it.
    runPostgresQueriesSync.mockReturnValue([
      {
        rows: [
          {
            id: "th1",
            owner_user_id: "u1",
            title: UUID_TITLE,
            title_slug: "placeholder",
            created_at: "2026-07-10T10:00:00.000Z",
            updated_at: "2026-07-10T10:00:00.000Z",
          },
        ],
      },
    ]);
    createAssistantThread({ id: "th1", ownerUserId: "u1", title: UUID_TITLE });

    // Exactly ONE insert attempt reached the database — the bare UUID-shaped
    // candidate was rejected pre-DB, so the FIRST (and only) real attempt is
    // already the suffixed candidate.
    expect(runPostgresQueriesSync).toHaveBeenCalledTimes(1);
    const q = runPostgresQueriesSync.mock.calls[0][0].queries[0];
    const mintedSlug = q.values[9] as string; // [...title, contextId, assistantPackage, instanceId, titleSlug]
    expect(mintedSlug).not.toBe(UUID_TITLE);
    expect(mintedSlug).not.toMatch(UUID_RE);
  });

  it("ensureThreadSlug skips a UUID-shaped slug candidate too", () => {
    runPostgresQueriesSync
      .mockReturnValueOnce([
        {
          rows: [
            {
              id: "th1",
              title: UUID_TITLE,
              title_slug: null,
              created_at: "2026-07-10T10:00:00.000Z",
              updated_at: "2026-07-10T10:00:00.000Z",
            },
          ],
        },
      ]) // the internal `existing = getAssistantThread(threadId)` read
      .mockReturnValueOnce([{ rowCount: 1, rows: [{ title_slug: "placeholder" }] }]); // the first REAL update attempt (suffixed)

    const slug = ensureThreadSlug("th1", UUID_TITLE);

    expect(slug).not.toBe(UUID_TITLE);
    expect(slug).not.toMatch(UUID_RE);
    // Two DB calls total: the existing-thread read, then the ONE update
    // attempt — confirms the bare UUID-shaped candidate never reached the DB.
    expect(runPostgresQueriesSync).toHaveBeenCalledTimes(2);
    const updateValues = runPostgresQueriesSync.mock.calls[1][0].queries[0].values as unknown[];
    expect(updateValues[0]).not.toBe(UUID_TITLE);
  });

  // codex round-3: the GUARANTEED-unique `uniqueTail` last resort (tried once
  // every random-suffix candidate has collided) derives its tail from the
  // thread's own hex-only id — for a title that ALSO happens to slugify to an
  // exact `xxxxxxxx-xxxx-xxxx-xxxx` (23-char) hex/hyphen prefix, appending
  // that raw hex tail would complete a full UUID-shaped 5th group. The
  // allocator call sites prefix the tail with a non-hex marker (`z`) for
  // exactly this reason — proven here by forcing FULL exhaustion (every
  // bare + random-suffix candidate collides) so the fallback is what
  // actually mints.
  it("the GUARANTEED-unique fallback candidate is never UUID-shaped even under full exhaustion", () => {
    // Neither UUID-shaped alone (only 4 hyphen-groups) — the bare candidate is
    // NOT rejected by the allocator's UUID guard, so every one of the 50
    // in-loop attempts genuinely reaches the (mocked-colliding) database.
    const PATHOLOGICAL_TITLE = "aaaaaaaa-bbbb-cccc-dddd";
    const THREAD_ID = "11111111-1111-1111-1111-111111111111";
    const collisionErr = new Error(
      'duplicate key value violates unique constraint "assistant_threads_container_slug_uniq"',
    );
    let calls = 0;
    runPostgresQueriesSync.mockImplementation(() => {
      calls += 1;
      // allocateByAttempt's for-loop makes maxTries+1 attempts before
      // breaking (the `tries++ >= maxTries` check compares the PRE-increment
      // value, so it runs one iteration past the nominal budget) — 51 attempts
      // for the default maxTries=50 — then the ONE uniqueTail fallback
      // attempt (call #52) succeeds.
      if (calls <= 51) throw collisionErr;
      return [
        {
          rows: [
            {
              id: THREAD_ID,
              owner_user_id: "u1",
              title: PATHOLOGICAL_TITLE,
              title_slug: "placeholder",
              created_at: "2026-07-10T10:00:00.000Z",
              updated_at: "2026-07-10T10:00:00.000Z",
            },
          ],
        },
      ];
    });

    const t = createAssistantThread({ id: THREAD_ID, ownerUserId: "u1", title: PATHOLOGICAL_TITLE });

    expect(t.id).toBe(THREAD_ID); // did NOT throw ThreadSlugExhaustedError
    expect(calls).toBe(52);
    const mintedSlug = runPostgresQueriesSync.mock.calls[51][0].queries[0].values[9] as string;
    // Without the non-hex marker this would be exactly
    // "aaaaaaaa-bbbb-cccc-dddd-111111111111" — a full UUID shape.
    expect(mintedSlug).not.toMatch(UUID_RE);
    expect(mintedSlug).toBe("aaaaaaaa-bbbb-cccc-dddd-z11111111111");
  });
});

// ---------------------------------------------------------------------------
// readAssistantTurnActivityByRunId (cinatra#2687) — the predicate the widget
// OBO token's authorization layer asks. It answers about the TURN, and it
// answers three ways so a caller can tell "this turn is over" from "I could not
// find out"; both refuse, and nothing here writes.
// ---------------------------------------------------------------------------
describe("readAssistantTurnActivityByRunId (#2687)", () => {
  beforeEach(() => {
    runPostgresQueriesSync.mockReset();
  });

  it("`active` while the turn is still running", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [{ status: "running" }] }]);
    expect(readAssistantTurnActivityByRunId("run-1")).toBe("active");
  });

  it("`ended` once the turn reached a terminal status", () => {
    // This is the whole point: `completed` is committed when the run finishes,
    // so a token sealed to this run stops authorizing then rather than at its
    // own expiry.
    runPostgresQueriesSync.mockReturnValue([{ rows: [{ status: "completed" }] }]);
    expect(readAssistantTurnActivityByRunId("run-1")).toBe("ended");
    runPostgresQueriesSync.mockReturnValue([{ rows: [{ status: "error" }] }]);
    expect(readAssistantTurnActivityByRunId("run-1")).toBe("ended");
  });

  it("`ended` for a run id no row carries, and for an unusable one — without a query", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [] }]);
    expect(readAssistantTurnActivityByRunId("run-nobody-has")).toBe("ended");
    runPostgresQueriesSync.mockClear();
    // A blank/absent/over-long run id names no turn, so there is nothing
    // indeterminate about it and the store is never touched.
    expect(readAssistantTurnActivityByRunId("")).toBe("ended");
    expect(readAssistantTurnActivityByRunId("   ")).toBe("ended");
    expect(readAssistantTurnActivityByRunId(undefined)).toBe("ended");
    expect(readAssistantTurnActivityByRunId(42)).toBe("ended");
    expect(readAssistantTurnActivityByRunId("r".repeat(129))).toBe("ended");
    expect(runPostgresQueriesSync).not.toHaveBeenCalled();
  });

  it("`unknown` when the store cannot answer — never a thrown error", () => {
    runPostgresQueriesSync.mockImplementation(() => {
      throw new Error("relation \"assistant_turns\" does not exist");
    });
    expect(readAssistantTurnActivityByRunId("run-1")).toBe("unknown");
  });

  it("reads the newest row for the run id, and reads only its status", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [{ status: "running" }] }]);
    readAssistantTurnActivityByRunId("  run-7  ");
    const call = runPostgresQueriesSync.mock.calls[0][0] as {
      queries: Array<{ text: string; values: unknown[] }>;
    };
    expect(call.queries[0].values).toEqual(["run-7"]); // trimmed
    expect(call.queries[0].text).toContain("SELECT status");
    // The TABLE and the BINDING PREDICATE are pinned, not just the shape (codex
    // round 0, LOW 1): a regression that read some other table, or dropped the
    // `run_id = $1` filter, would answer `active` about an unrelated live turn
    // and authorize a completed token while a shape-only assertion stayed green.
    expect(call.queries[0].text).toContain('"assistant_turns"');
    expect(call.queries[0].text).toContain("WHERE run_id = $1");
    expect(call.queries[0].text).toContain("ORDER BY created_at DESC");
    expect(call.queries[0].text).toContain("LIMIT 1");
    // A read-only predicate: it must never appear in a write path.
    expect(call.queries[0].text).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b/);
  });
});
