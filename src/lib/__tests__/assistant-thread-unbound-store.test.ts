// Unbound-thread store primitives (cinatra#2642) — the IMPLICIT-DEFAULT alias.
//
// The postgres sync leaves are mocked so the pure decision table and the exact
// SQL these primitives assemble are exercised without a database; the live
// behaviour (a real row repaired by a real access, and the container-security
// refusals) is proven against real Postgres by
// chat-unbound-thread-repair.integration.test.ts.
//
// A separate file from assistant-thread-store.test.ts so the #2589 suite stays
// byte-unchanged.
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
  getOwnedUnboundAssistantThreadById,
  getOwnedUnboundAssistantThreadBySlug,
  isImplicitDefaultThreadEligible,
  isUnboundAssistantThread,
  repairImplicitDefaultThreadBinding,
  type AssistantThread,
  type UnboundThreadActor,
} from "../assistant-thread-store";

const ACTOR: UnboundThreadActor = { userId: "user-1", orgId: "org-1" };
const THREAD_ID = "cc862657-cbad-4aa9-b815-36eb839510da";

/** The issue's row: a title, an EMPTY assistant_package and an EMPTY
 *  title_slug — a thread whose first turn errored before anything bound it. */
function unboundThread(over: Partial<AssistantThread> = {}): AssistantThread {
  return {
    id: THREAD_ID,
    assistantUserId: null,
    ownerUserId: "user-1",
    orgId: "org-1",
    projectId: null,
    teamId: null,
    origin: "assistant-native",
    title: "What connectors do you have and can you tell me my schedule",
    contextId: null,
    assistantPackage: "",
    instanceId: "",
    titleSlug: "",
    createdAt: "2026-08-10T09:00:00.000Z",
    updatedAt: "2026-08-10T09:00:00.000Z",
    ...over,
  };
}

function threadRow(t: AssistantThread): Record<string, unknown> {
  return {
    id: t.id,
    assistant_user_id: t.assistantUserId,
    owner_user_id: t.ownerUserId,
    org_id: t.orgId,
    project_id: t.projectId,
    team_id: t.teamId,
    origin: t.origin,
    title: t.title,
    context_id: t.contextId,
    assistant_package: t.assistantPackage,
    instance_id: t.instanceId,
    title_slug: t.titleSlug,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  };
}

beforeEach(() => {
  runPostgresQueriesSync.mockReset();
});

describe("isUnboundAssistantThread", () => {
  it("treats NULL and the empty string alike as unset", () => {
    expect(isUnboundAssistantThread(unboundThread())).toBe(true);
    expect(
      isUnboundAssistantThread(unboundThread({ assistantPackage: null, instanceId: null })),
    ).toBe(true);
  });
  it("a bound thread is not unbound (package OR instance is enough)", () => {
    expect(
      isUnboundAssistantThread(unboundThread({ assistantPackage: "@cinatra-ai/cinatra-assistant" })),
    ).toBe(false);
    expect(isUnboundAssistantThread(unboundThread({ instanceId: "inst-1" }))).toBe(false);
  });
});

describe("isImplicitDefaultThreadEligible — the decision table", () => {
  it("the issue's row, read by its OWNER, is eligible", () => {
    expect(isImplicitDefaultThreadEligible(unboundThread(), ACTOR)).toBe(true);
  });

  it("a BOUND thread is never eligible (the exact-container rule keeps it)", () => {
    const bound = unboundThread({ assistantPackage: "@cinatra-ai/cinatra-assistant" });
    expect(isImplicitDefaultThreadEligible(bound, ACTOR)).toBe(false);
  });

  it("ANOTHER actor's thread is never eligible", () => {
    expect(isImplicitDefaultThreadEligible(unboundThread(), { userId: "user-2", orgId: "org-1" })).toBe(
      false,
    );
  });

  it("an OWNERLESS (legacy) row is never eligible", () => {
    expect(isImplicitDefaultThreadEligible(unboundThread({ ownerUserId: null }), ACTOR)).toBe(false);
    expect(isImplicitDefaultThreadEligible(unboundThread({ ownerUserId: "" }), ACTOR)).toBe(false);
  });

  it("a TEAM-owned row is never eligible", () => {
    expect(
      isImplicitDefaultThreadEligible(unboundThread({ teamId: "team-9", ownerUserId: "user-1" }), ACTOR),
    ).toBe(false);
  });

  it("a row anchored to ANOTHER org is never eligible (cross-org seal)", () => {
    expect(isImplicitDefaultThreadEligible(unboundThread({ orgId: "org-2" }), ACTOR)).toBe(false);
  });

  it("an org-LESS row owned by the actor stays eligible", () => {
    expect(isImplicitDefaultThreadEligible(unboundThread({ orgId: null }), ACTOR)).toBe(true);
  });

  it("an org-anchored row is refused for an actor with NO active org", () => {
    expect(isImplicitDefaultThreadEligible(unboundThread(), { userId: "user-1", orgId: null })).toBe(
      false,
    );
  });

  it("reads an EMPTY team_id / org_id as ABSENT — the same reading the UPDATE uses", () => {
    // The pure decision and the repair's WHERE clause must agree on '' vs NULL,
    // or a row could resolve read-only yet never be repairable (codex round-1).
    expect(isImplicitDefaultThreadEligible(unboundThread({ teamId: "" }), ACTOR)).toBe(true);
    expect(isImplicitDefaultThreadEligible(unboundThread({ orgId: "" }), ACTOR)).toBe(true);
  });

  it("an empty actor id is refused outright", () => {
    expect(isImplicitDefaultThreadEligible(unboundThread(), { userId: "", orgId: "org-1" })).toBe(
      false,
    );
  });
});

describe("getOwnedUnboundAssistantThreadById", () => {
  it("rejects a NON-UUID segment before touching the database", () => {
    expect(getOwnedUnboundAssistantThreadById("my-thread-slug", ACTOR)).toBeNull();
    expect(runPostgresQueriesSync).not.toHaveBeenCalled();
  });

  it("returns the row for its owner", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [threadRow(unboundThread())], rowCount: 1 }]);
    expect(getOwnedUnboundAssistantThreadById(THREAD_ID, ACTOR)?.id).toBe(THREAD_ID);
  });

  it("returns null for another actor, even though the row exists", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [threadRow(unboundThread())], rowCount: 1 }]);
    expect(getOwnedUnboundAssistantThreadById(THREAD_ID, { userId: "user-2", orgId: "org-1" })).toBeNull();
  });

  it("returns null for a BOUND row", () => {
    runPostgresQueriesSync.mockReturnValue([
      { rows: [threadRow(unboundThread({ assistantPackage: "@acme/helper-assistant" }))], rowCount: 1 },
    ]);
    expect(getOwnedUnboundAssistantThreadById(THREAD_ID, ACTOR)).toBeNull();
  });
});

describe("getOwnedUnboundAssistantThreadBySlug", () => {
  it("refuses the EMPTY slug without a query (it addresses nothing)", () => {
    expect(getOwnedUnboundAssistantThreadBySlug("", ACTOR)).toBeNull();
    expect(runPostgresQueriesSync).not.toHaveBeenCalled();
  });

  it("scopes the SQL to an unbound, team-less row owned by the ACTOR", () => {
    runPostgresQueriesSync.mockReturnValue([
      { rows: [threadRow(unboundThread({ titleSlug: "my-chat" }))], rowCount: 1 },
    ]);
    const t = getOwnedUnboundAssistantThreadBySlug("my-chat", ACTOR);
    expect(t?.id).toBe(THREAD_ID);
    const call = runPostgresQueriesSync.mock.calls[0][0] as {
      queries: Array<{ text: string; values: unknown[] }>;
    };
    const { text, values } = call.queries[0];
    expect(text).toContain("COALESCE(assistant_package, '') = ''");
    expect(text).toContain("COALESCE(instance_id, '') = ''");
    expect(text).toContain("COALESCE(team_id, '') = ''");
    expect(text).toContain("owner_user_id = $2");
    expect(values).toEqual(["my-chat", "user-1"]);
  });

  it("re-applies the pure decision on the mapped row (predicate-drift guard)", () => {
    // A row the SQL somehow returned but the decision table refuses (another
    // org) must NOT resolve.
    runPostgresQueriesSync.mockReturnValue([
      { rows: [threadRow(unboundThread({ titleSlug: "my-chat", orgId: "org-2" }))], rowCount: 1 },
    ]);
    expect(getOwnedUnboundAssistantThreadBySlug("my-chat", ACTOR)).toBeNull();
  });
});

describe("repairImplicitDefaultThreadBinding", () => {
  it("re-asserts the FULL eligibility predicate in the UPDATE and writes the default package", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [], rowCount: 1 }]);
    expect(repairImplicitDefaultThreadBinding(THREAD_ID, ACTOR)).toBe(true);
    const call = runPostgresQueriesSync.mock.calls[0][0] as {
      queries: Array<{ text: string; values: unknown[] }>;
    };
    const { text, values } = call.queries[0];
    expect(values[0]).toBe("@cinatra-ai/cinatra-assistant");
    expect(values).toEqual(["@cinatra-ai/cinatra-assistant", THREAD_ID, "user-1", "org-1"]);
    expect(text).toContain("COALESCE(assistant_package, '') = ''");
    expect(text).toContain("COALESCE(instance_id, '') = ''");
    expect(text).toContain("COALESCE(team_id, '') = ''");
    expect(text).toContain("owner_user_id = $3");
    expect(text).toContain("(COALESCE(org_id, '') = '' OR org_id = $4)");
    // The empty-string slug is normalized OUT of the partial unique index; a
    // real slug is never touched.
    expect(text).toContain("title_slug = NULLIF(title_slug, '')");
    // A repair is NOT thread activity — it must not reorder the sidebar.
    expect(text).not.toContain("updated_at");
  });

  it("takes NO destination package — it can only ever write the default one", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [], rowCount: 1 }]);
    repairImplicitDefaultThreadBinding(THREAD_ID, ACTOR);
    const call = runPostgresQueriesSync.mock.calls[0][0] as {
      queries: Array<{ text: string; values: unknown[] }>;
    };
    expect(call.queries[0].values.filter((v) => v === "@acme/helper-assistant")).toHaveLength(0);
    // The signature itself carries no package parameter (compile-time proof
    // lives in the type; this pins the arity at runtime).
    expect(repairImplicitDefaultThreadBinding.length).toBe(2);
  });

  it("reports FALSE when the predicate no longer holds (0 rows updated)", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [], rowCount: 0 }]);
    expect(repairImplicitDefaultThreadBinding(THREAD_ID, ACTOR)).toBe(false);
  });

  it("rejects a non-UUID id and an empty actor without a query", () => {
    expect(repairImplicitDefaultThreadBinding("not-a-uuid", ACTOR)).toBe(false);
    expect(repairImplicitDefaultThreadBinding(THREAD_ID, { userId: "", orgId: null })).toBe(false);
    expect(runPostgresQueriesSync).not.toHaveBeenCalled();
  });

  it("a container-slug collision is a SILENT, non-fatal refusal (best-effort)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    runPostgresQueriesSync.mockImplementation(() => {
      throw new Error(
        'duplicate key value violates unique constraint "assistant_threads_container_slug_uniq"',
      );
    });
    expect(repairImplicitDefaultThreadBinding(THREAD_ID, ACTOR)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("an UNEXPECTED failure is logged, never thrown (resolution must not 500)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    runPostgresQueriesSync.mockImplementation(() => {
      throw new Error("connection terminated");
    });
    expect(repairImplicitDefaultThreadBinding(THREAD_ID, ACTOR)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
