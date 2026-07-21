// cinatra-ai/cinatra#1037 — the legacy chat_threads → structured
// assistant_threads/assistant_turns write-through MIRROR builders
// (src/lib/project-inheritance.ts).
//
// These pin the codex-converged mirror semantics:
//   - injective, `legacy:`-namespaced deterministic turn ids;
//   - metadata + attribution + (P5.6 drop-history PR1 EXPAND) durable per-turn
//     CONTENT — the full message object, written through so the structured store
//     holds what /chat needs for faithful reconstruction (run_id still NEVER
//     fabricated; the unified stream contract owns the durable event log);
//   - structured pause/resume rows projected from payload.pausedParticipants,
//     presence-gated so a partial write never clears pause state it didn't carry;
//   - reconcile DELETE scoped to the mirror namespace (a legacy write can
//     never delete a runtime-minted turn row);
//   - constant-parameter multi-row INSERT (no per-message parameters);
//   - org tenancy anchor SET-ONCE, team threads deferred to NULL;
//   - raw-byte title extraction (no trim normalization);
//   - guarded deletes (structured-only threads untouchable by legacy deletes).

import { describe, expect, it } from "vitest";
import {
  LEGACY_MIRROR_TURN_ID_PREFIX,
  buildLegacyMirrorTurnId,
  extractRawStringFieldFromThread,
  extractAssistantTurnMirrorRowsFromThread,
  extractPausedParticipantsFromThread,
  extractThreadScalarsFromThread,
  resolveAssistantMirrorOrgId,
  buildAssistantThreadMirrorUpsertQuery,
  buildAssistantTurnMirrorReconcileQueries,
  buildAssistantPauseStateReconcileQueries,
  buildAssistantThreadMirrorQueries,
  buildAssistantThreadMirrorDeleteQuery,
} from "@/lib/project-inheritance";

const SCHEMA = "cinatra";

describe("mirror turn id", () => {
  it("is namespaced under the reserved prefix and length-prefixed", () => {
    expect(buildLegacyMirrorTurnId("t1", "m1")).toBe("legacy:2:t1:m1");
    expect(buildLegacyMirrorTurnId("t1", "m1").startsWith(LEGACY_MIRROR_TURN_ID_PREFIX)).toBe(true);
  });

  it("is INJECTIVE for ids with embedded colons (adversarial pair)", () => {
    // Without the length prefix these two pairs would both encode "a:b:c".
    const a = buildLegacyMirrorTurnId("a:b", "c"); // legacy:3:a:b:c
    const b = buildLegacyMirrorTurnId("a", "b:c"); // legacy:1:a:b:c
    expect(a).not.toBe(b);
  });

  // The store-side reserved-prefix constant equality is pinned in
  // assistant-thread-store.test.ts (which carries the store's DB mocks).
});

describe("extractRawStringFieldFromThread", () => {
  it("preserves exact bytes (no trim)", () => {
    expect(extractRawStringFieldFromThread({ title: "  padded  " }, "title")).toBe("  padded  ");
    expect(extractRawStringFieldFromThread({ title: "" }, "title")).toBe("");
  });
  it("returns null for missing/non-string", () => {
    expect(extractRawStringFieldFromThread({}, "title")).toBeNull();
    expect(extractRawStringFieldFromThread({ title: 7 }, "title")).toBeNull();
  });
});

describe("extractAssistantTurnMirrorRowsFromThread", () => {
  const thread = {
    id: "t1",
    messages: [
      { id: "m1", role: "user", content: "hi", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "m2", role: "assistant", content: "yo", createdAt: "2026-01-01T00:00:01.000Z", authorUserId: "asst-9", parts: [{ type: "text", text: "yo" }] },
      { id: "", role: "user", content: "no id" }, // skipped: empty id
      { role: "user", content: "missing id" }, // skipped: no id
      { id: "m3", role: "system", content: "bad role" }, // skipped: out-of-domain role
      { id: "m4", role: "user", content: "bad ts", createdAt: "not-a-date" },
      "not-an-object", // skipped
    ],
  };

  it("maps valid messages to rows, skipping invalid ones", () => {
    const rows = extractAssistantTurnMirrorRowsFromThread(thread as never);
    expect(rows.map((r) => r.id)).toEqual([
      "legacy:2:t1:m1",
      "legacy:2:t1:m2",
      "legacy:2:t1:m4",
    ]);
    expect(rows[0]).toEqual({
      id: "legacy:2:t1:m1",
      assistantUserId: null,
      role: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
      ordinal: 0,
      content: JSON.stringify(thread.messages[0]),
    });
    // Attribution passthrough (I4 shadow).
    expect(rows[1].assistantUserId).toBe("asst-9");
    expect(rows[1].role).toBe("assistant");
    // ordinal is the EMITTED-row index: the skipped invalid messages between m2
    // and m4 leave NO gap, so m4 is ordinal 2 (faithful array order of survivors).
    expect(rows[1].ordinal).toBe(1);
    expect(rows[2].ordinal).toBe(2);
    // Invalid timestamp degrades to null (SQL falls back to now()).
    expect(rows[2].createdAt).toBeNull();
  });

  it("captures the FULL message object as durable content (faithful by construction)", () => {
    const rows = extractAssistantTurnMirrorRowsFromThread(thread as never);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        "assistantUserId",
        "content",
        "createdAt",
        "id",
        "ordinal",
        "role",
      ]);
    }
    // parse(content) deep-equals the source message (the fidelity contract).
    expect(JSON.parse(rows[1].content!)).toEqual(thread.messages[1]);
  });

  it("dedupes duplicate message ids defensively", () => {
    const rows = extractAssistantTurnMirrorRowsFromThread({
      id: "t1",
      messages: [
        { id: "m1", role: "user", content: "a" },
        { id: "m1", role: "user", content: "b" },
      ],
    } as never);
    expect(rows).toHaveLength(1);
  });

  it("returns [] for absent/non-array messages", () => {
    expect(extractAssistantTurnMirrorRowsFromThread({ id: "t1" } as never)).toEqual([]);
    expect(extractAssistantTurnMirrorRowsFromThread({ id: "t1", messages: "x" } as never)).toEqual([]);
  });
});

describe("extractPausedParticipantsFromThread", () => {
  it("returns null ONLY when the field is absent (own-property) — leave rows untouched", () => {
    expect(extractPausedParticipantsFromThread({})).toBeNull();
    expect(extractPausedParticipantsFromThread({ title: "x" })).toBeNull();
  });
  it("present-but-malformed clears (fail-closed, never silently preserve stale)", () => {
    // The field IS present, so we reconcile; a non-array value yields the empty
    // set (clears stale rows) rather than returning null (untouched).
    expect(extractPausedParticipantsFromThread({ pausedParticipants: "x" as never })).toEqual([]);
    expect(extractPausedParticipantsFromThread({ pausedParticipants: null as never })).toEqual([]);
    expect(extractPausedParticipantsFromThread({ pausedParticipants: { a: 1 } as never })).toEqual([]);
  });
  it("returns the deduped non-empty ids (empty array is a real 'clear all')", () => {
    expect(extractPausedParticipantsFromThread({ pausedParticipants: [] })).toEqual([]);
    expect(
      extractPausedParticipantsFromThread({ pausedParticipants: ["cinatra", "asst-9", "cinatra", "", 7] as never }),
    ).toEqual(["cinatra", "asst-9"]);
  });
});

describe("extractThreadScalarsFromThread (durable render-state, PR2)", () => {
  it("captures the present, well-typed render-state scalars", () => {
    expect(
      extractThreadScalarsFromThread({
        activeAssistantHandle: "alpha",
        taggedAssistantUserIds: ["asst-a", "asst-b"],
        slackMode: true,
      }),
    ).toEqual({ activeAssistantHandle: "alpha", taggedAssistantUserIds: ["asst-a", "asst-b"], slackMode: true });
  });
  it("filters malformed tagged ids and drops absent/blank fields", () => {
    expect(
      extractThreadScalarsFromThread({ taggedAssistantUserIds: ["asst-a", "", 7, null] as never, activeAssistantHandle: "" }),
    ).toEqual({ taggedAssistantUserIds: ["asst-a"] });
  });
  it("returns null when NO render-state scalar is present (column stays NULL)", () => {
    expect(extractThreadScalarsFromThread({ id: "t1", title: "x" })).toBeNull();
    expect(extractThreadScalarsFromThread({})).toBeNull();
  });
  it("slackMode must be a real boolean (ignores truthy non-booleans)", () => {
    expect(extractThreadScalarsFromThread({ slackMode: "yes" as never })).toBeNull();
    expect(extractThreadScalarsFromThread({ slackMode: false })).toEqual({ slackMode: false });
  });
});

describe("resolveAssistantMirrorOrgId", () => {
  it("team-owned threads mirror with NULL org (S2 decides team→org anchoring)", () => {
    expect(resolveAssistantMirrorOrgId({ teamId: "team-1" }, "org-1")).toBeNull();
  });
  it("personal threads use the explicit mirror org", () => {
    expect(resolveAssistantMirrorOrgId({ ownerUserId: "u1" }, "org-1")).toBe("org-1");
    expect(resolveAssistantMirrorOrgId({ ownerUserId: "u1" }, null)).toBeNull();
  });
});

describe("buildAssistantThreadMirrorUpsertQuery", () => {
  const q = buildAssistantThreadMirrorUpsertQuery({
    schemaName: SCHEMA,
    threadId: "t1",
    ownerUserId: "u1",
    orgId: "org-1",
    projectId: "proj-1",
    teamId: "team-1",
    scalars: { slackMode: true, taggedAssistantUserIds: ["asst-a"] },
    title: "  Title ",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  });

  it("targets assistant_threads with the expected parameter order (incl. project_id + team_id + origin + scalars)", () => {
    expect(q.text).toContain(`INSERT INTO "${SCHEMA}"."assistant_threads"`);
    expect(q.text).toContain("(id, owner_user_id, org_id, project_id, team_id, origin, scalars, title, created_at, updated_at)");
    // origin is a SQL LITERAL ('legacy-chat'), not a bound parameter, so the
    // scalars/title/timestamp param positions are UNSHIFTED ($6::jsonb).
    expect(q.text).toContain("$5, 'legacy-chat', $6::jsonb");
    expect(q.text).toContain("$6::jsonb"); // scalars cast to jsonb (shifted by team_id)
    expect(q.values).toEqual([
      "t1",
      "u1",
      "org-1",
      "proj-1",
      "team-1",
      JSON.stringify({ slackMode: true, taggedAssistantUserIds: ["asst-a"] }),
      "  Title ",
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    ]);
  });

  it("scalars is null → the jsonb param is null (not the string 'null')", () => {
    const qn = buildAssistantThreadMirrorUpsertQuery({
      schemaName: SCHEMA, threadId: "t1", ownerUserId: null, orgId: null, projectId: null,
      teamId: null, scalars: null, title: null, createdAt: null, updatedAt: null,
    });
    expect(qn.values[5]).toBeNull(); // scalars param (shifted by team_id)
  });

  it("org_id is SET-ONCE on conflict (existing anchor wins over EXCLUDED)", () => {
    expect(q.text).toContain("org_id        = COALESCE(assistant_threads.org_id, EXCLUDED.org_id)");
  });

  it("owner_user_id + team_id are SET-ONCE authz axes on conflict (codex: never wholesale-clear ownership)", () => {
    expect(q.text).toContain("owner_user_id = COALESCE(assistant_threads.owner_user_id, EXCLUDED.owner_user_id)");
    expect(q.text).toContain("team_id       = COALESCE(assistant_threads.team_id, EXCLUDED.team_id)");
  });

  it("origin is SET-ONCE PROVENANCE (mirror always projects 'legacy-chat' but never overwrites an established origin)", () => {
    // The mirror is the 'legacy-chat' writer; the conflict clause COALESCE-preserves
    // any established origin so a legacy write can never re-brand an
    // 'assistant-native' thread (which would let the delegate-all wipe reach it).
    expect(q.text).toContain("origin        = COALESCE(assistant_threads.origin, EXCLUDED.origin)");
  });

  it("project_id + scalars mirror the payload wholesale on conflict (mutable projection, matches chat_threads)", () => {
    expect(q.text).toContain("project_id    = EXCLUDED.project_id");
    expect(q.text).toContain("scalars       = EXCLUDED.scalars");
  });

  it("created_at is immutable post-INSERT; updated_at mirrors the payload", () => {
    const updateClause = q.text.split("ON CONFLICT")[1];
    expect(updateClause).not.toContain("created_at =");
    expect(updateClause).toContain("updated_at    = EXCLUDED.updated_at");
  });

  it("never touches the S2-owned columns (assistant_user_id, context_id)", () => {
    expect(q.text).not.toContain("assistant_user_id");
    expect(q.text).not.toContain("context_id");
  });
});

describe("buildAssistantTurnMirrorReconcileQueries", () => {
  const turns = [
    { id: "legacy:2:t1:m1", assistantUserId: null, role: "user" as const, createdAt: "2026-01-01T00:00:00.000Z", ordinal: 0, content: '{"id":"m1","role":"user","content":"hi"}' },
    { id: "legacy:2:t1:m2", assistantUserId: "asst-9", role: "assistant" as const, createdAt: null, ordinal: 1, content: '{"id":"m2","role":"assistant","content":"yo"}' },
  ];

  it("emits reconcile DELETE scoped to the mirror namespace, then one INSERT", () => {
    const [del, ins] = buildAssistantTurnMirrorReconcileQueries({
      schemaName: SCHEMA,
      threadId: "t1",
      turns,
    });
    expect(del.text).toContain(`DELETE FROM "${SCHEMA}"."assistant_turns"`);
    expect(del.text).toContain(`id LIKE '${LEGACY_MIRROR_TURN_ID_PREFIX}%'`);
    expect(del.text).toContain("NOT (id = ANY($2::text[]))");
    expect(del.values).toEqual(["t1", ["legacy:2:t1:m1", "legacy:2:t1:m2"]]);

    // Constant parameter count regardless of history length: parallel arrays,
    // the durable content array as $6 and the faithful-order ordinal as $7.
    expect(ins.text).toContain(`INSERT INTO "${SCHEMA}"."assistant_turns"`);
    expect(ins.text).toContain("unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[])");
    expect(ins.values).toEqual([
      "t1",
      ["legacy:2:t1:m1", "legacy:2:t1:m2"],
      [null, "asst-9"],
      ["user", "assistant"],
      ["2026-01-01T00:00:00.000Z", null],
      ['{"id":"m1","role":"user","content":"hi"}', '{"id":"m2","role":"assistant","content":"yo"}'],
      [0, 1],
    ]);
  });

  it("run_id is NULL (never fabricated), status 'completed', ordinal projected", () => {
    const [, ins] = buildAssistantTurnMirrorReconcileQueries({
      schemaName: SCHEMA,
      threadId: "t1",
      turns,
    });
    expect(ins.text).toContain("SELECT t.id, $1, NULL, t.assistant_user_id, t.role, 'completed', t.content::jsonb, t.ordinal::int");
  });

  it("writes durable content + ordinal (PR1/PR2) and refreshes them on conflict", () => {
    const [, ins] = buildAssistantTurnMirrorReconcileQueries({
      schemaName: SCHEMA,
      threadId: "t1",
      turns,
    });
    // content + ordinal columns present, cast, and refreshed on a re-write
    // (edit/regenerate reusing the same message id).
    expect(ins.text).toContain("content");
    expect(ins.text).toContain("ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, ordinal = EXCLUDED.ordinal, updated_at = now()");
    // Still never copies the raw legacy `payload` column name.
    for (const { text } of [ins]) {
      expect(text.toLowerCase()).not.toContain("payload");
    }
  });

  it("an empty message list emits ONLY the reconcile delete (full truncation)", () => {
    const queries = buildAssistantTurnMirrorReconcileQueries({
      schemaName: SCHEMA,
      threadId: "t1",
      turns: [],
    });
    expect(queries).toHaveLength(1);
    expect(queries[0].values).toEqual(["t1", []]);
  });
});

describe("buildAssistantPauseStateReconcileQueries", () => {
  it("clears rows not in the set, then upserts the paused participants", () => {
    const [del, ins] = buildAssistantPauseStateReconcileQueries({
      schemaName: SCHEMA,
      threadId: "t1",
      participantIds: ["cinatra", "asst-9"],
    });
    expect(del.text).toContain(`DELETE FROM "${SCHEMA}"."assistant_thread_pause_state"`);
    expect(del.text).toContain("NOT (participant_id = ANY($2::text[]))");
    expect(del.values).toEqual(["t1", ["cinatra", "asst-9"]]);
    expect(ins.text).toContain(`INSERT INTO "${SCHEMA}"."assistant_thread_pause_state"`);
    expect(ins.text).toContain("ON CONFLICT (thread_id, participant_id) DO NOTHING");
    expect(ins.values).toEqual(["t1", ["cinatra", "asst-9"]]);
  });

  it("an empty set clears all pause rows (only the delete, no insert)", () => {
    const queries = buildAssistantPauseStateReconcileQueries({
      schemaName: SCHEMA,
      threadId: "t1",
      participantIds: [],
    });
    expect(queries).toHaveLength(1);
    expect(queries[0].values).toEqual(["t1", []]);
  });
});

describe("buildAssistantThreadMirrorQueries composition (pause presence-gating)", () => {
  it("omits pause reconcile when the payload has no pausedParticipants", () => {
    const queries = buildAssistantThreadMirrorQueries({
      schemaName: SCHEMA,
      thread: { id: "t1", messages: [] },
      explicitMirrorOrgId: null,
    });
    expect(queries.some((q) => q.text.includes("assistant_thread_pause_state"))).toBe(false);
  });

  it("includes pause reconcile when pausedParticipants is present (even empty)", () => {
    const queries = buildAssistantThreadMirrorQueries({
      schemaName: SCHEMA,
      thread: { id: "t1", messages: [], pausedParticipants: [] },
      explicitMirrorOrgId: null,
    });
    expect(queries.some((q) => q.text.includes("assistant_thread_pause_state"))).toBe(true);
  });
});

describe("structured-authoritative mirror deletes", () => {
  it("single delete targets the structured row directly (no EXISTS(chat_threads) guard)", () => {
    // PR2 CUTOVER: the EXISTS(chat_threads) guard was DROPPED — a post-cutover
    // structured-only thread has NO chat_threads row, so the guard would make
    // the structured delete a silent no-op. The delete is now
    // structured-authoritative; assistant_turns FK-cascade cleans the turns.
    const q = buildAssistantThreadMirrorDeleteQuery(SCHEMA, "t1");
    expect(q.text).toContain(`DELETE FROM "${SCHEMA}"."assistant_threads"`);
    expect(q.text).toContain("WHERE id = $1");
    expect(q.text).not.toContain("chat_threads");
    expect(q.values).toEqual(["t1"]);
  });

  // The GLOBAL set-form mirror-delete-all builder was RETIRED in the PR2 CUTOVER
  // (its wipe of the full chat_threads set was the cross-tenant vuln). The
  // delete-all path is now OWNER + 'legacy-chat' scoped inside
  // deleteAllChatThreadsFromDatabase — covered in the database delete tests.
});
