// cinatra-ai/cinatra#1037 P2b — the legacy chat_threads → structured
// assistant_threads/assistant_turns write-through MIRROR builders
// (src/lib/project-inheritance.ts).
//
// These pin the codex-converged mirror semantics:
//   - injective, `legacy:`-namespaced deterministic turn ids;
//   - metadata + attribution ONLY (no content column, no fabricated run_id —
//     the unified stream contract owns the durable event log);
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
  resolveAssistantMirrorOrgId,
  buildAssistantThreadMirrorUpsertQuery,
  buildAssistantTurnMirrorReconcileQueries,
  buildAssistantThreadMirrorDeleteQuery,
  buildAssistantThreadMirrorDeleteAllQuery,
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
      { id: "m2", role: "assistant", content: "yo", createdAt: "2026-01-01T00:00:01.000Z", authorUserId: "asst-9" },
      { id: "", role: "user", content: "no id" }, // skipped: empty id
      { role: "user", content: "missing id" }, // skipped: no id
      { id: "m3", role: "system", content: "bad role" }, // skipped: out-of-domain role
      { id: "m4", role: "user", content: "bad ts", createdAt: "not-a-date" },
      "not-an-object", // skipped
    ],
  };

  it("maps valid messages to metadata rows, skipping invalid ones", () => {
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
    });
    // Attribution passthrough (I4 shadow).
    expect(rows[1].assistantUserId).toBe("asst-9");
    expect(rows[1].role).toBe("assistant");
    // Invalid timestamp degrades to null (SQL falls back to now()).
    expect(rows[2].createdAt).toBeNull();
  });

  it("NEVER extracts message content", () => {
    const rows = extractAssistantTurnMirrorRowsFromThread(thread as never);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["assistantUserId", "createdAt", "id", "role"]);
    }
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
    title: "  Title ",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  });

  it("targets assistant_threads with the expected parameter order", () => {
    expect(q.text).toContain(`INSERT INTO "${SCHEMA}"."assistant_threads"`);
    expect(q.values).toEqual([
      "t1",
      "u1",
      "org-1",
      "  Title ",
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    ]);
  });

  it("org_id is SET-ONCE on conflict (existing anchor wins over EXCLUDED)", () => {
    expect(q.text).toContain("org_id        = COALESCE(assistant_threads.org_id, EXCLUDED.org_id)");
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
    { id: "legacy:2:t1:m1", assistantUserId: null, role: "user" as const, createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "legacy:2:t1:m2", assistantUserId: "asst-9", role: "assistant" as const, createdAt: null },
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

    // Constant parameter count regardless of history length: parallel arrays.
    expect(ins.text).toContain(`INSERT INTO "${SCHEMA}"."assistant_turns"`);
    expect(ins.text).toContain("unnest($2::text[], $3::text[], $4::text[], $5::text[])");
    expect(ins.text).toContain("ON CONFLICT (id) DO NOTHING");
    expect(ins.values).toEqual([
      "t1",
      ["legacy:2:t1:m1", "legacy:2:t1:m2"],
      [null, "asst-9"],
      ["user", "assistant"],
      ["2026-01-01T00:00:00.000Z", null],
    ]);
  });

  it("run_id is NULL (never fabricated) and status is 'completed'", () => {
    const [, ins] = buildAssistantTurnMirrorReconcileQueries({
      schemaName: SCHEMA,
      threadId: "t1",
      turns,
    });
    expect(ins.text).toContain("SELECT t.id, $1, NULL, t.assistant_user_id, t.role, 'completed'");
  });

  it("NO content column anywhere (no double persistence)", () => {
    const queries = buildAssistantTurnMirrorReconcileQueries({
      schemaName: SCHEMA,
      threadId: "t1",
      turns,
    });
    for (const { text } of queries) {
      expect(text.toLowerCase()).not.toContain("content");
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

describe("guarded mirror deletes", () => {
  it("single delete only fires when a matching LEGACY row exists", () => {
    const q = buildAssistantThreadMirrorDeleteQuery(SCHEMA, "t1");
    expect(q.text).toContain(`DELETE FROM "${SCHEMA}"."assistant_threads"`);
    expect(q.text).toContain(`EXISTS (SELECT 1 FROM "${SCHEMA}"."chat_threads" WHERE id = $1)`);
    expect(q.values).toEqual(["t1"]);
  });

  it("delete-all is scoped to ids present in chat_threads (set form of the guard)", () => {
    const q = buildAssistantThreadMirrorDeleteAllQuery(SCHEMA);
    expect(q.text).toContain(`WHERE id IN (SELECT id FROM "${SCHEMA}"."chat_threads")`);
    expect(q.values).toEqual([]);
  });
});
