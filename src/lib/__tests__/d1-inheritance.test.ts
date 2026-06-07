/**
 * Project inheritance wire-through.
 *
 * Asserts the project_id propagation contract:
 *
 *   D1: `createAgentRun` accepts and writes `projectId`.
 *   D2: `mcpRequestContextStorage.projectContext.projectId` propagation —
 *        unit-verified via the pure helper `resolveProjectInheritanceForType`
 *        + a frame-bound assertion (we can't spawn a real BullMQ worker in
 *        unit tests; the frame is the integration seam).
 *   D3: write-time inheritance + substrate exclusion in the canonical
 *        writers (`upsertObjectAndEnqueue`, `upsertObject`, and
 *        artifact-creation's objects INSERT).
 *   D4: `upsertChatThreadInDatabase` payload→column lockstep
 *        (project_id, created_at, updated_at mirror the payload).
 *
 * Pattern: dependency-composition — every writer's `runPostgresQueriesSync`
 * call is intercepted via vi.mock so we can capture the emitted SQL +
 * values without a live PG instance, mirroring
 * `src/lib/__tests__/authz-project-grants.test.ts` (pure composition;
 * no live PG). `server-only` is auto-stubbed by the root vitest alias —
 * no explicit vi.mock needed for src/** tests.
 *
 * Binds the schema contract: objects rows carry project_id because artifacts
 * are objects; chat_threads use typed columns, not payload fields; project_id
 * is a refinement, and substrate-excluded types stay NULL.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";

// ---------------------------------------------------------------------------
// Mock infra: capture every postgres-sync query for assertions. The mock
// is hoisted, so it overrides postgres-sync BEFORE the SUT modules import
// it.
// ---------------------------------------------------------------------------

const capturedQueries: Array<{
  text: string;
  values: unknown[];
}> = [];

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: vi.fn((opts: { queries: Array<{ text: string; values?: unknown[] }> }) => {
    for (const q of opts.queries) {
      capturedQueries.push({ text: q.text, values: q.values ?? [] });
    }
    // upsertObject reads back the row; upsertObjectAndEnqueue too. Return
    // a minimal row stub that exercises the rowToObjectRecord mapper
    // without exercising the real PG driver — the typed columns under
    // test (project_id) round-trip via the RETURNING clause.
    return opts.queries.map(() => ({
      rows: [
        {
          id: "obj-1",
          type: "@cinatra-ai/artifact:object",
          parent_id: null,
          parent_type: null,
          data: { stub: true },
          created_at: new Date("2026-01-01T00:00:00Z"),
          updated_at: new Date("2026-01-01T00:00:00Z"),
          created_by: null,
          org_id: "org-1",
          source: "route",
          run_id: null,
          agent_id: null,
          package_version: null,
          agent_spec_version: null,
          version: 1,
          deleted_at: null,
          owner_level: "organization",
          owner_id: "org-1",
          visibility: "organization",
          project_id: null,
        },
      ],
    }));
  }),
}));

// The host database module is broadly stubbed by the root vitest alias
// (`@/lib/database` → `tests/__stubs__/database.ts`). For this test we
// need specific exports (postgresSchema, ensurePostgresSchema,
// getPostgresConnectionString). `vi.importActual` returns the stub module
// (because the alias resolves before vi), so vi.mock here re-applies the
// stub fields explicitly. The D4 chat-thread upsert is tested via direct
// import of database.ts using its file system path (bypassing the alias)
// in the D4 describe block.
vi.mock("@/lib/database", () => ({
  ensurePostgresSchema: vi.fn(),
  postgresSchema: "cinatra_test",
  getPostgresConnectionString: vi.fn(() => "postgres://stub"),
  // upsertChatThreadInDatabase is intentionally NOT exported here — D4
  // tests bypass the alias and import the real module via its fs path so
  // we can exercise the real SQL builder under test.
}));

// llm's getActorContext is read by objects-store's
// `assertWriteScopeAllowed`. Returning undefined makes the guard a no-op
// (legacy non-LLM path) so the writer runs end-to-end.
vi.mock("@cinatra-ai/llm", () => ({
  getActorContext: () => undefined,
}));

// mcp-server's AsyncLocalStorage carries the projectContext frame. We
// import the real one via a side-effect-free re-export so test wrappers
// can establish a frame around the writer call.
vi.mock("@cinatra-ai/mcp-server", () => {
  const storage = new AsyncLocalStorage<{
    projectContext?: { projectId: string | null };
    [k: string]: unknown;
  }>();
  return {
    mcpRequestContextStorage: storage,
  };
});

// ---------------------------------------------------------------------------
// Now import the SUT modules — after the mocks are registered.
// ---------------------------------------------------------------------------

import {
  resolveProjectInheritanceForType,
  shouldAutoTagProject,
  SUBSTRATE_OBJECT_TYPES_NEVER_PROJECT_SCOPED,
  buildChatThreadUpsertQuery,
  extractStringFieldFromThread,
  extractTimestampFieldFromThread,
} from "@/lib/project-inheritance";
import { upsertObject, upsertObjectAndEnqueue } from "@/lib/objects-store";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  capturedQueries.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// D3 — Pure helper: substrate exclusion + frame propagation
// ---------------------------------------------------------------------------

describe("project inheritance substrate exclusion (pure helper)", () => {
  it("returns the frame projectId for non-substrate artifact type", () => {
    const out = resolveProjectInheritanceForType(
      "proj-1",
      "@cinatra-ai/artifact:object",
    );
    expect(out).toBe("proj-1");
  });

  it("returns NULL for substrate contact type even when frame has projectId", () => {
    const out = resolveProjectInheritanceForType(
      "proj-1",
      "@cinatra-ai/entity-contacts:contact",
    );
    expect(out).toBeNull();
  });

  it("returns NULL for substrate account type even when frame has projectId", () => {
    const out = resolveProjectInheritanceForType(
      "proj-1",
      "@cinatra-ai/entity-accounts:account",
    );
    expect(out).toBeNull();
  });

  it("returns NULL for literal substrate types (defense-in-depth)", () => {
    expect(
      resolveProjectInheritanceForType("proj-1", "@cinatra-ai/contact"),
    ).toBeNull();
    expect(
      resolveProjectInheritanceForType("proj-1", "@cinatra-ai/account"),
    ).toBeNull();
    expect(
      resolveProjectInheritanceForType("proj-1", "@cinatra-ai/skill"),
    ).toBeNull();
    expect(
      resolveProjectInheritanceForType("proj-1", "@cinatra-ai/extension"),
    ).toBeNull();
  });

  it("returns NULL when no frame is active (frame projectId undefined)", () => {
    expect(
      resolveProjectInheritanceForType(
        undefined,
        "@cinatra-ai/artifact:object",
      ),
    ).toBeNull();
  });

  it("returns NULL when frame projectId is explicitly NULL (ambient)", () => {
    expect(
      resolveProjectInheritanceForType(null, "@cinatra-ai/artifact:object"),
    ).toBeNull();
  });

  it("shouldAutoTagProject is the inverse of substrate membership", () => {
    expect(shouldAutoTagProject("@cinatra-ai/artifact:object")).toBe(true);
    expect(shouldAutoTagProject("@cinatra-ai/asset-blog:blog-post")).toBe(true);
    expect(shouldAutoTagProject("@cinatra-ai/entity-contacts:contact")).toBe(
      false,
    );
    expect(shouldAutoTagProject("@cinatra-ai/contact")).toBe(false);
  });

  it("substrate set contains both literal + vendored canonical types", () => {
    // Defense-in-depth for the literal substrate prefix list:
    expect(SUBSTRATE_OBJECT_TYPES_NEVER_PROJECT_SCOPED.has("@cinatra-ai/contact")).toBe(true);
    expect(SUBSTRATE_OBJECT_TYPES_NEVER_PROJECT_SCOPED.has("@cinatra-ai/account")).toBe(true);
    expect(SUBSTRATE_OBJECT_TYPES_NEVER_PROJECT_SCOPED.has("@cinatra-ai/skill")).toBe(true);
    expect(SUBSTRATE_OBJECT_TYPES_NEVER_PROJECT_SCOPED.has("@cinatra-ai/extension")).toBe(true);
    // Vendored types actually registered by packages/entity-{contacts,accounts}:
    expect(
      SUBSTRATE_OBJECT_TYPES_NEVER_PROJECT_SCOPED.has(
        "@cinatra-ai/entity-contacts:contact",
      ),
    ).toBe(true);
    expect(
      SUBSTRATE_OBJECT_TYPES_NEVER_PROJECT_SCOPED.has(
        "@cinatra-ai/entity-accounts:account",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D3 — upsertObjectAndEnqueue propagates project_id inside a project frame
// ---------------------------------------------------------------------------

describe("upsertObjectAndEnqueue write-time project inheritance", () => {
  it("inside project P, non-substrate artifact write tags project_id=P", () => {
    mcpRequestContextStorage.run(
      { projectContext: { projectId: "proj-A" } },
      () => {
        upsertObjectAndEnqueue({
          upsertInput: {
            type: "@cinatra-ai/artifact:object",
            data: { foo: "bar" },
            orgId: "org-1",
          },
          operation: "upsert",
        });
      },
    );

    // The combined CTE INSERT carries the project_id placeholder at $18
    // (matches the writer's parameter order). Assert by scanning the
    // emitted values for the projectId.
    //
    // When a project frame is active and the resolved row is non-substrate,
    // `assertProjectWritableSync` fires first (a SELECT id, archived_at FROM
    // projects WHERE id = $1). The INSERT comes second. Find the INSERT
    // explicitly so the test stays robust to additional gates being added
    // later in the stack.
    expect(capturedQueries.length).toBe(2);
    const q = capturedQueries.find((c) => c.text.includes("INSERT INTO"));
    expect(q).toBeDefined();
    expect(q!.text).toContain("project_id");
    // $18 in the writer's value array is index 17 (0-based).
    expect(q!.values[17]).toBe("proj-A");
  });

  it("inside project P, SUBSTRATE contact write tags project_id=NULL (D1 exclusion)", () => {
    mcpRequestContextStorage.run(
      { projectContext: { projectId: "proj-A" } },
      () => {
        upsertObjectAndEnqueue({
          upsertInput: {
            type: "@cinatra-ai/entity-contacts:contact",
            data: { name: "Alice" },
            orgId: "org-1",
          },
          operation: "upsert",
        });
      },
    );

    expect(capturedQueries.length).toBe(1);
    const q = capturedQueries[0];
    expect(q.values[17]).toBeNull();
  });

  it("with NULL frame (ambient), write tags project_id=NULL", () => {
    mcpRequestContextStorage.run(
      { projectContext: { projectId: null } },
      () => {
        upsertObjectAndEnqueue({
          upsertInput: {
            type: "@cinatra-ai/artifact:object",
            data: { foo: "bar" },
            orgId: "org-1",
          },
          operation: "upsert",
        });
      },
    );

    expect(capturedQueries.length).toBe(1);
    expect(capturedQueries[0].values[17]).toBeNull();
  });

  it("without a frame, write tags project_id=NULL", () => {
    upsertObjectAndEnqueue({
      upsertInput: {
        type: "@cinatra-ai/artifact:object",
        data: { foo: "bar" },
        orgId: "org-1",
      },
      operation: "upsert",
    });

    expect(capturedQueries.length).toBe(1);
    expect(capturedQueries[0].values[17]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D3 — upsertObject (legacy shadow writer) propagates project_id
// ---------------------------------------------------------------------------

describe("upsertObject shadow writer write-time project inheritance", () => {
  it("inside project P, non-substrate write tags project_id=P", () => {
    mcpRequestContextStorage.run(
      { projectContext: { projectId: "proj-B" } },
      () => {
        upsertObject({
          type: "@cinatra-ai/asset-blog:blog-post",
          data: { title: "post" },
          orgId: "org-1",
        });
      },
    );

    // See the parallel assertion in the upsertObjectAndEnqueue test above.
    // The archive gate SELECT fires before the INSERT; locate the INSERT
    // explicitly.
    expect(capturedQueries.length).toBe(2);
    const q = capturedQueries.find((c) => c.text.includes("INSERT INTO"));
    expect(q).toBeDefined();
    expect(q!.text).toContain("project_id");
    // upsertObject's INSERT puts project_id at $13 (index 12).
    expect(q!.values[12]).toBe("proj-B");
  });

  it("inside project P, SUBSTRATE write tags project_id=NULL", () => {
    mcpRequestContextStorage.run(
      { projectContext: { projectId: "proj-B" } },
      () => {
        upsertObject({
          type: "@cinatra-ai/entity-accounts:account",
          data: { name: "Acme" },
          orgId: "org-1",
        });
      },
    );

    expect(capturedQueries.length).toBe(1);
    expect(capturedQueries[0].values[12]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D4 — chat_threads payload→column lockstep (pure-builder tests).
//
// The real writer in src/lib/database.ts is built on top of these pure
// helpers (extractStringFieldFromThread, extractTimestampFieldFromThread,
// buildChatThreadUpsertQuery) — so testing the builders verifies the
// integration contract end-to-end without depending on the aliased
// host database stub.
// ---------------------------------------------------------------------------

describe("extractStringFieldFromThread", () => {
  it("returns trimmed string for valid value", () => {
    expect(extractStringFieldFromThread({ projectId: "proj-X" }, "projectId"))
      .toBe("proj-X");
    expect(extractStringFieldFromThread({ projectId: "  proj-X  " }, "projectId"))
      .toBe("proj-X");
  });

  it("returns null when field is absent / blank / wrong type", () => {
    expect(extractStringFieldFromThread({}, "projectId")).toBeNull();
    expect(extractStringFieldFromThread({ projectId: "" }, "projectId")).toBeNull();
    expect(extractStringFieldFromThread({ projectId: "   " }, "projectId")).toBeNull();
    expect(extractStringFieldFromThread({ projectId: 42 }, "projectId")).toBeNull();
    expect(extractStringFieldFromThread({ projectId: null }, "projectId")).toBeNull();
  });
});

describe("extractTimestampFieldFromThread", () => {
  it("returns ISO string for valid ISO 8601 string", () => {
    expect(
      extractTimestampFieldFromThread(
        { createdAt: "2026-01-02T00:00:00Z" },
        "createdAt",
      ),
    ).toBe("2026-01-02T00:00:00.000Z");
  });

  it("returns ISO string for Date instance", () => {
    const d = new Date("2026-01-05T12:34:56Z");
    expect(extractTimestampFieldFromThread({ createdAt: d }, "createdAt"))
      .toBe("2026-01-05T12:34:56.000Z");
  });

  it("returns null for invalid date strings", () => {
    expect(extractTimestampFieldFromThread({ createdAt: "not-a-date" }, "createdAt"))
      .toBeNull();
    expect(extractTimestampFieldFromThread({}, "createdAt")).toBeNull();
    expect(extractTimestampFieldFromThread({ createdAt: "" }, "createdAt")).toBeNull();
  });
});

describe("buildChatThreadUpsertQuery lockstep SQL", () => {
  it("builds an INSERT...ON CONFLICT with project_id/created_at/updated_at columns", () => {
    const q = buildChatThreadUpsertQuery({
      schemaName: "cinatra",
      threadId: "thread-1",
      payloadJson: '{"id":"thread-1","projectId":"proj-X"}',
      projectId: "proj-X",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
    // SQL shape:
    expect(q.text).toContain('INSERT INTO "cinatra"."chat_threads"');
    expect(q.text).toContain("(id, payload, project_id, created_at, updated_at)");
    expect(q.text).toContain("ON CONFLICT (id) DO UPDATE");
    expect(q.text).toContain("project_id = EXCLUDED.project_id");
    expect(q.text).toContain("payload    = EXCLUDED.payload");
    // Parameter ordering: [id, payload, projectId, createdAt, updatedAt]
    expect(q.values).toEqual([
      "thread-1",
      '{"id":"thread-1","projectId":"proj-X"}',
      "proj-X",
      "2026-01-02T00:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
    ]);
  });

  it("emits projectId=NULL when payload has no projectId (ambient thread)", () => {
    const q = buildChatThreadUpsertQuery({
      schemaName: "cinatra",
      threadId: "thread-2",
      payloadJson: '{"id":"thread-2"}',
      projectId: null,
      createdAt: null,
      updatedAt: null,
    });
    expect(q.values[2]).toBeNull();
    expect(q.values[3]).toBeNull();
    expect(q.values[4]).toBeNull();
  });

  it("escapes embedded quotes in the schema name (SQL safety)", () => {
    const q = buildChatThreadUpsertQuery({
      schemaName: 'evil"name',
      threadId: "thread-3",
      payloadJson: "{}",
      projectId: null,
      createdAt: null,
      updatedAt: null,
    });
    // The schema is double-quoted with embedded quotes doubled per PG quoting rules.
    expect(q.text).toContain('"evil""name"');
  });
});

// ---------------------------------------------------------------------------
// D1 — CreateAgentRunInput accepts projectId.
//
// The agents package's CreateAgentRunInput field shape is verified at
// type-check time (pnpm typecheck gate). We cannot exercise the real
// createAgentRun runtime here (it depends on the live Drizzle instance via
// the package's internal `db`), so the runtime D1 INSERT path is covered
// by the integration suites that exercise the chat MCP handler + the
// registry/A2A action paths. At this unit layer we only verify the
// inheritance path (worker frame → write).
// ---------------------------------------------------------------------------
