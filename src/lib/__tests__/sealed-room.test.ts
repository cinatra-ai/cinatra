/**
 * Sealed-room read filter.
 *
 * TDD coverage for the centralized predicate (`src/lib/sealed-room.ts`)
 * AND the SQL-data-layer half (`listObjectsByFilter` in
 * `src/lib/objects-store.ts`) that enforces the Graphiti / semantic-search
 * re-filter contract:
 *
 *   `objects_list({query, projectId:P})` may receive candidate IDs from
 *   project P + project Q + ambient (Graphiti search returns by
 *   semantic similarity, not by project boundary). The result MUST
 *   contain only rows tagged for P. The re-filter is non-bypassable
 *   because the SQL `WHERE project_id = $P` clause runs INSIDE
 *   `listObjectsByFilter` — every caller (including a future caller
 *   that supplies `ids: [...]`) intersects with the project boundary.
 *
 * Mirrors the dependency-composition pattern in
 * `src/lib/__tests__/d1-inheritance.test.ts`: mock `postgres-sync`
 * so the writer/reader's emitted SQL + values are captured without a
 * live Postgres instance. `server-only` is auto-stubbed by the root
 * vitest alias (vitest.config.ts).
 *
 * `objects.project_id` is the canonical column for project scoping; artifacts
 * are objects. A project is a resource refinement, never an ownership tier.
 *
 * This file does NOT import the context resolver (`contextResolve` /
 * `resolveContext` / `context-resolver` / `run-context`). The sealed-room
 * path is independent of the resolver.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock infra — capture every postgres-sync invocation so we can assert the
// emitted SQL contains the sealed-room clause + values. The mock is
// hoisted, so it overrides postgres-sync BEFORE the SUT modules import it.
// ---------------------------------------------------------------------------

const capturedQueries: Array<{ text: string; values: unknown[] }> = [];

// Per-test row stub override (so individual tests can simulate "this is
// what PG would return given the WHERE clause"). The mock defaults to an
// empty result set; tests override via setMockRows([...]).
let mockRows: Array<Record<string, unknown>> = [];

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: vi.fn((opts: { queries: Array<{ text: string; values?: unknown[] }> }) => {
    for (const q of opts.queries) {
      capturedQueries.push({ text: q.text, values: q.values ?? [] });
    }
    return opts.queries.map(() => ({ rows: mockRows }));
  }),
}));

// Host database module — broadly stubbed by the root vitest alias
// (tests/__stubs__/database.ts). Re-apply the specific exports
// listObjectsByFilter needs.
vi.mock("@/lib/database", () => ({
  ensurePostgresSchema: vi.fn(),
  postgresSchema: "cinatra_test",
  getPostgresConnectionString: vi.fn(() => "postgres://stub"),
}));

// llm's getActorContext is consulted by objects-store's
// `assertWriteScopeAllowed`. Returning undefined makes the guard a no-op.
vi.mock("@cinatra-ai/llm", () => ({
  getActorContext: () => undefined,
}));

// mcp-server's AsyncLocalStorage — not used by the read path under test,
// but stubbed because objects-store imports it at module-load for the
// write paths.
vi.mock("@cinatra-ai/mcp-server", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return { mcpRequestContextStorage: new AsyncLocalStorage() };
});

// ---------------------------------------------------------------------------
// SUT imports — after the mocks are registered.
// ---------------------------------------------------------------------------

import {
  resolveSealedRoomMode,
  assertProjectReadAccess,
  isSealedRoomEnabledFor,
  sealedRoomFilterValue,
} from "@/lib/sealed-room";
import { listObjectsByFilter } from "@/lib/objects-store";
import { AuthzError } from "@/lib/authz/errors";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setMockRows(rows: Array<Partial<Record<string, unknown>>>): void {
  // Minimum shape the row→record mapper accepts; project_id passes through.
  mockRows = rows.map((r) => ({
    id: r.id ?? "obj-x",
    type: r.type ?? "@cinatra-ai/artifact:object",
    parent_id: null,
    parent_type: null,
    data: r.data ?? {},
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    created_by: null,
    org_id: r.org_id ?? "org-1",
    source: "route",
    run_id: null,
    agent_id: null,
    package_version: null,
    agent_spec_version: null,
    version: 1,
    deleted_at: null,
    owner_level: "organization",
    owner_id: r.org_id ?? "org-1",
    visibility: "organization",
    project_id: r.project_id ?? null,
  }));
}

beforeEach(() => {
  capturedQueries.length = 0;
  mockRows = [];
  // Reset feature-flag env so each test starts from default ON.
  delete process.env.CINATRA_SEALED_ROOM_OBJECTS;
  delete process.env.CINATRA_SEALED_ROOM_AGENT_RUNS;
  delete process.env.CINATRA_SEALED_ROOM_CHAT_THREADS;
  delete process.env.CINATRA_SEALED_ROOM_ARTIFACTS;
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// resolveSealedRoomMode (pure classifier)
// ---------------------------------------------------------------------------

describe("resolveSealedRoomMode", () => {
  it("returns 'ambient' when projectId is undefined", () => {
    expect(resolveSealedRoomMode({})).toBe("ambient");
  });

  it("returns 'ambient' when projectId is explicitly null", () => {
    expect(resolveSealedRoomMode({ projectId: null })).toBe("ambient");
  });

  it("returns 'ambient' when projectId is an empty string", () => {
    expect(resolveSealedRoomMode({ projectId: "" })).toBe("ambient");
  });

  it("returns 'ambient' when projectId is whitespace-only", () => {
    expect(resolveSealedRoomMode({ projectId: "   " })).toBe("ambient");
  });

  it("returns 'project' for a non-blank projectId", () => {
    expect(resolveSealedRoomMode({ projectId: "proj-A" })).toBe("project");
  });
});

// ---------------------------------------------------------------------------
// assertProjectReadAccess (404-hidden authz gate)
// ---------------------------------------------------------------------------

describe("assertProjectReadAccess", () => {
  it("throws AuthzError 404 hidden when actor is undefined", () => {
    let thrown: unknown;
    try {
      assertProjectReadAccess(undefined, "proj-A");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AuthzError);
    const err = thrown as AuthzError;
    expect(err.statusCode).toBe(404);
    expect(err.reason).toBe("hidden");
  });

  it("throws AuthzError 404 hidden when actor has no projectGrants array", () => {
    let thrown: unknown;
    try {
      assertProjectReadAccess(
        { platformRole: "member" } as unknown as Parameters<typeof assertProjectReadAccess>[0],
        "proj-A",
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AuthzError);
    expect((thrown as AuthzError).statusCode).toBe(404);
  });

  it("throws AuthzError 404 hidden when projectGrants does NOT include the projectId", () => {
    let thrown: unknown;
    try {
      assertProjectReadAccess(
        {
          platformRole: "member",
          projectGrants: [
            { projectId: "proj-B", effectiveRole: "read", accessSource: "user" },
          ],
        } as unknown as Parameters<typeof assertProjectReadAccess>[0],
        "proj-A",
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AuthzError);
    expect((thrown as AuthzError).statusCode).toBe(404);
    expect((thrown as AuthzError).reason).toBe("hidden");
  });

  it("passes silently when projectGrants includes the projectId (any role)", () => {
    expect(() =>
      assertProjectReadAccess(
        {
          platformRole: "member",
          projectGrants: [
            { projectId: "proj-A", effectiveRole: "read", accessSource: "user" },
          ],
        } as unknown as Parameters<typeof assertProjectReadAccess>[0],
        "proj-A",
      ),
    ).not.toThrow();
  });

  it("passes silently for platform_admin even WITHOUT any projectGrants (admin bypass)", () => {
    expect(() =>
      assertProjectReadAccess(
        {
          platformRole: "platform_admin",
          // no projectGrants at all
        } as unknown as Parameters<typeof assertProjectReadAccess>[0],
        "proj-A",
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

describe("per-table feature flags", () => {
  it("default ON for every table when env var is unset", () => {
    expect(isSealedRoomEnabledFor("objects")).toBe(true);
    expect(isSealedRoomEnabledFor("agent_runs")).toBe(true);
    expect(isSealedRoomEnabledFor("chat_threads")).toBe(true);
    expect(isSealedRoomEnabledFor("artifacts")).toBe(true);
  });

  it("ON when env var is set to anything other than literal 'false'", () => {
    process.env.CINATRA_SEALED_ROOM_OBJECTS = "true";
    expect(isSealedRoomEnabledFor("objects")).toBe(true);
    process.env.CINATRA_SEALED_ROOM_OBJECTS = "1";
    expect(isSealedRoomEnabledFor("objects")).toBe(true);
    process.env.CINATRA_SEALED_ROOM_OBJECTS = "yes";
    expect(isSealedRoomEnabledFor("objects")).toBe(true);
    // Asymmetric on purpose — only literal "false" disables the gate.
    process.env.CINATRA_SEALED_ROOM_OBJECTS = "0";
    expect(isSealedRoomEnabledFor("objects")).toBe(true);
    process.env.CINATRA_SEALED_ROOM_OBJECTS = "off";
    expect(isSealedRoomEnabledFor("objects")).toBe(true);
  });

  it("OFF only when env var is literal 'false' (case-insensitive)", () => {
    process.env.CINATRA_SEALED_ROOM_OBJECTS = "false";
    expect(isSealedRoomEnabledFor("objects")).toBe(false);
    process.env.CINATRA_SEALED_ROOM_OBJECTS = "FALSE";
    expect(isSealedRoomEnabledFor("objects")).toBe(false);
    process.env.CINATRA_SEALED_ROOM_OBJECTS = "  False  ";
    expect(isSealedRoomEnabledFor("objects")).toBe(false);
  });

  it("sealedRoomFilterValue returns null when ambient (regardless of flag)", () => {
    expect(sealedRoomFilterValue("objects", null)).toBeNull();
    expect(sealedRoomFilterValue("objects", undefined)).toBeNull();
    expect(sealedRoomFilterValue("objects", "")).toBeNull();
    expect(sealedRoomFilterValue("objects", "  ")).toBeNull();
  });

  it("sealedRoomFilterValue returns the projectId when project mode + flag ON", () => {
    expect(sealedRoomFilterValue("objects", "proj-A")).toBe("proj-A");
    expect(sealedRoomFilterValue("agent_runs", "proj-A")).toBe("proj-A");
    expect(sealedRoomFilterValue("chat_threads", "proj-A")).toBe("proj-A");
    expect(sealedRoomFilterValue("artifacts", "proj-A")).toBe("proj-A");
  });

  it("sealedRoomFilterValue returns null when flag OFF (kill switch)", () => {
    process.env.CINATRA_SEALED_ROOM_OBJECTS = "false";
    expect(sealedRoomFilterValue("objects", "proj-A")).toBeNull();
    // Other tables unaffected.
    expect(sealedRoomFilterValue("agent_runs", "proj-A")).toBe("proj-A");
  });

  it("sealedRoomFilterValue trims projectId before returning", () => {
    expect(sealedRoomFilterValue("objects", "  proj-A  ")).toBe("proj-A");
  });
});

// ---------------------------------------------------------------------------
// listObjectsByFilter ambient mode
// ---------------------------------------------------------------------------

describe("listObjectsByFilter ambient mode", () => {
  it("WITHOUT projectId, the SQL does NOT include 'project_id =' clause", () => {
    setMockRows([
      { id: "o1", project_id: "proj-A" },
      { id: "o2", project_id: "proj-B" },
      { id: "o3", project_id: null },
    ]);
    const result = listObjectsByFilter({ orgId: "org-1" });
    expect(result).toHaveLength(3);
    expect(capturedQueries).toHaveLength(1);
    expect(capturedQueries[0].text).not.toMatch(/project_id\s*=\s*\$/);
    // None of the bound values should be a project id.
    expect(capturedQueries[0].values).not.toContain("proj-A");
  });

  it("WITHOUT projectId, returned rows include EVERY project_id (mixed)", () => {
    setMockRows([
      { id: "o1", project_id: "proj-A" },
      { id: "o2", project_id: "proj-B" },
      { id: "o3", project_id: null },
    ]);
    const result = listObjectsByFilter({ orgId: "org-1" });
    const projectIds = result.map((r) => r.projectId);
    // The mock returns all rows; the assertion is that the SQL WHERE
    // doesn't filter by project_id. (Whether ObjectRecord exposes
    // projectId publicly is asserted indirectly via the rowToObjectRecord
    // mapper — we check ids round-trip.)
    expect(result.map((r) => r.id).sort()).toEqual(["o1", "o2", "o3"]);
    // sanity (projectIds may be undefined depending on mapper shape):
    expect(projectIds.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// listObjectsByFilter project mode (sealed-room SQL filter applied)
// ---------------------------------------------------------------------------

describe("listObjectsByFilter project mode", () => {
  it("WITH projectId='P', SQL adds `project_id = $N` and binds 'P'", () => {
    setMockRows([{ id: "o1", project_id: "proj-A" }]);
    listObjectsByFilter({ orgId: "org-1", projectId: "proj-A" });
    expect(capturedQueries).toHaveLength(1);
    const q = capturedQueries[0];
    expect(q.text).toMatch(/project_id\s*=\s*\$\d+/);
    expect(q.values).toContain("proj-A");
  });

  it("WITH projectId='P' AND type filter, BOTH clauses are present", () => {
    setMockRows([{ id: "o1", project_id: "proj-A" }]);
    listObjectsByFilter({
      orgId: "org-1",
      type: "@cinatra-ai/artifact:object",
      projectId: "proj-A",
    });
    const q = capturedQueries[0];
    expect(q.text).toMatch(/type\s*=\s*\$/);
    expect(q.text).toMatch(/project_id\s*=\s*\$/);
    expect(q.values).toContain("@cinatra-ai/artifact:object");
    expect(q.values).toContain("proj-A");
  });

  it("WITH projectId='', ambient behavior (no clause) — blank is treated as ambient", () => {
    setMockRows([{ id: "o1" }]);
    listObjectsByFilter({ orgId: "org-1", projectId: "" });
    const q = capturedQueries[0];
    expect(q.text).not.toMatch(/project_id\s*=\s*\$/);
  });

  it("WITH projectId=null, ambient behavior (no clause)", () => {
    setMockRows([{ id: "o1" }]);
    listObjectsByFilter({ orgId: "org-1", projectId: null });
    const q = capturedQueries[0];
    expect(q.text).not.toMatch(/project_id\s*=\s*\$/);
  });
});

// ---------------------------------------------------------------------------
// Graphiti / semantic-search re-filter inside listObjectsByFilter
// ---------------------------------------------------------------------------

describe("Graphiti re-filter (BOTH ids AND projectId)", () => {
  it("WITH ids=[...] (Graphiti rank) AND projectId='P', SQL emits BOTH `id = ANY($ids)` AND `project_id = $P`", () => {
    setMockRows([{ id: "o1", project_id: "proj-A" }]);
    listObjectsByFilter({
      orgId: "org-1",
      ids: ["o1", "o2-from-Q", "o3-ambient"],
      projectId: "proj-A",
    });
    expect(capturedQueries).toHaveLength(1);
    const q = capturedQueries[0];
    // BOTH clauses must be present (the intersection is the canonical
    // re-filter — without project_id, candidates from project Q and
    // ambient would leak through; without the id-set, ALL P rows
    // would be returned).
    expect(q.text).toMatch(/id\s*=\s*ANY\(\$\d+::text\[\]\)/);
    expect(q.text).toMatch(/project_id\s*=\s*\$\d+/);
    // Both bound values are present.
    expect(q.values).toEqual(
      expect.arrayContaining([
        ["o1", "o2-from-Q", "o3-ambient"],
        "proj-A",
      ]),
    );
  });

  it("the re-filter is enforced in the data layer (non-bypassable from the handler)", () => {
    // This is a structural assertion: any caller that supplies both
    // `ids` and `projectId` MUST emit BOTH SQL clauses. A future
    // caller cannot bypass project_id by handing in ids alone if
    // they also supply projectId — the AND-clause is unconditionally
    // appended when sealedRoomFilterValue returns non-null.
    setMockRows([]);
    listObjectsByFilter({
      orgId: "org-1",
      ids: ["candidate-1", "candidate-2"],
      projectId: "proj-A",
    });
    expect(capturedQueries[0].text).toMatch(/project_id\s*=\s*\$/);
  });
});

// ---------------------------------------------------------------------------
// Feature flag OFF: ambient behavior is restored
// ---------------------------------------------------------------------------

describe("feature flag OFF restores ambient behavior", () => {
  it("WITH projectId='P' AND CINATRA_SEALED_ROOM_OBJECTS='false', SQL omits the project_id clause", () => {
    process.env.CINATRA_SEALED_ROOM_OBJECTS = "false";
    setMockRows([{ id: "o1", project_id: "proj-A" }]);
    listObjectsByFilter({ orgId: "org-1", projectId: "proj-A" });
    const q = capturedQueries[0];
    expect(q.text).not.toMatch(/project_id\s*=\s*\$/);
    expect(q.values).not.toContain("proj-A");
  });

  it("WITH projectId='P' AND ids=[...] AND flag OFF, only `id = ANY` is emitted (ambient ids)", () => {
    process.env.CINATRA_SEALED_ROOM_OBJECTS = "false";
    setMockRows([{ id: "o1" }]);
    listObjectsByFilter({
      orgId: "org-1",
      ids: ["o1", "o2-from-Q"],
      projectId: "proj-A",
    });
    const q = capturedQueries[0];
    expect(q.text).toMatch(/id\s*=\s*ANY\(\$\d+::text\[\]\)/);
    expect(q.text).not.toMatch(/project_id\s*=\s*\$/);
  });
});

// ---------------------------------------------------------------------------
// Resolver-isolation self-check
// ---------------------------------------------------------------------------

describe("resolver-isolation self-check (LIST handlers do not reference the context resolver)", () => {
  // The LIST handlers must stay independent from the context resolver.
  // The unit asserts that invariant in-process so a future refactor that
  // adds a resolver import would have to break this assertion too.
  //
  // The pattern is broken up into substrings so the test source
  // itself does NOT contain the forbidden joined token.
  const FORBIDDEN_HALF_A = "context" + "-" + "resolver";
  const FORBIDDEN_HALF_B = "run" + "-" + "context";

  it("packages/objects/src/mcp/handlers.ts has no context resolver import", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const target = path.resolve(here, "..", "..", "..", "packages", "objects", "src", "mcp", "handlers.ts");
    const src = await fs.readFile(target, "utf8");
    expect(src.includes(`from "@/lib/${FORBIDDEN_HALF_A}`)).toBe(false);
    expect(src.includes(`from "@/lib/${FORBIDDEN_HALF_B}`)).toBe(false);
  });

  it("packages/agents/src/mcp/handlers.ts has no context resolver import", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const target = path.resolve(here, "..", "..", "..", "packages", "agents", "src", "mcp", "handlers.ts");
    const src = await fs.readFile(target, "utf8");
    expect(src.includes(`from "@/lib/${FORBIDDEN_HALF_A}`)).toBe(false);
    expect(src.includes(`from "@/lib/${FORBIDDEN_HALF_B}`)).toBe(false);
  });
});
