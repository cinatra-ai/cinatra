// Postgres-primary CRUD on src/lib/objects-store.ts.
//
// Covers the four exports:
//   - getObjectById(id, scope)
//   - listObjectsByFilter(filter)
//   - softDeleteObject(id, scope)
//   - upsertObjectAndEnqueue({ upsertInput, operation, payloadHash? })
//
// All four mock @/lib/postgres-sync to capture the SQL/values passed to
// runPostgresQueriesSync without touching a real PG instance. The two write
// functions exercise the atomic-outbox guarantee: a SINGLE
// runPostgresQueriesSync call with `transaction: true` — never split into two
// calls, which would break atomicity between the object write and outbox insert.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: vi.fn(),
}));

vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => "postgres://test",
  ensurePostgresSchema: () => undefined,
  postgresSchema: "cinatra",
}));

import {
  getObjectById,
  listObjectsByFilter,
  MAX_EXTERNAL_IDS_BATCH,
  softDeleteObject,
  upsertObjectAndEnqueue,
} from "@/lib/objects-store";
import { objectsListSchema } from "../mcp/schemas";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
// The request frame the ambient write-time inheritance reads (cinatra#1377
// contrasts the explicit binding against it). Real AsyncLocalStorage via the
// package's mcp-server test stub.
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";

const runPg = runPostgresQueriesSync as unknown as ReturnType<typeof vi.fn>;

const baseRow = (overrides: Record<string, unknown> = {}) => ({
  id: "abc",
  type: "test",
  parent_id: null,
  parent_type: null,
  data: {},
  created_at: new Date(),
  updated_at: new Date(),
  created_by: null,
  org_id: "org-1",
  source: null,
  run_id: null,
  agent_id: null,
  package_version: null,
  agent_spec_version: null,
  version: 1,
  deleted_at: null,
  ...overrides,
});

// ---------------------------------------------------------------------------
// upsertObjectAndEnqueue (atomic outbox)
// ---------------------------------------------------------------------------

describe("upsertObjectAndEnqueue (atomic outbox)", () => {
  beforeEach(() => {
    runPg.mockReset();
    // The single CTE query returns one result set containing the object row.
    runPg.mockReturnValue([{ rows: [baseRow()] }]);
  });

  it("Test 1: calls runPostgresQueriesSync exactly once with transaction:true and 1 CTE query", () => {
    upsertObjectAndEnqueue({
      upsertInput: { id: "abc", type: "test", data: {}, orgId: "org-1" },
      operation: "upsert",
    });
    expect(runPg).toHaveBeenCalledOnce();
    const callArg = runPg.mock.calls[0][0];
    expect(callArg.transaction).toBe(true);
    expect(callArg.queries).toHaveLength(1);
  });

  it("Test 2: CTE embeds outbox insert with operation='upsert' and status='pending'", () => {
    upsertObjectAndEnqueue({
      upsertInput: { id: "abc", type: "test", data: {}, orgId: "org-1" },
      operation: "upsert",
    });
    const queries = runPg.mock.calls[0][0].queries;
    // The outbox INSERT is embedded in the CTE (queries[0]), not issued as a second query.
    const cteQ = queries[0];
    expect(cteQ.text).toContain("INSERT INTO");
    expect(cteQ.text).toContain("graphiti_projection_outbox");
    expect(cteQ.text).toContain("'pending'");
    expect(cteQ.values).toContain("upsert");
  });

  it("Test 8: bumps version on UPDATE conflict", () => {
    upsertObjectAndEnqueue({
      upsertInput: { id: "abc", type: "test", data: {}, orgId: "org-1" },
      operation: "upsert",
    });
    const upsertSql = runPg.mock.calls[0][0].queries[0].text;
    expect(upsertSql).toMatch(/version\s*=\s*"cinatra"\."objects"\.version\s*\+\s*1/);
  });

  it("Test 9: cross-tenant upsert collision throws (CTE returns empty when WHERE filters out)", () => {
    // Simulate the org-guard WHERE evaluating false: the single CTE RETURNING produces zero rows.
    // With the CTE shape, only one query is issued and no spurious outbox row is committed.
    runPg.mockReset();
    runPg.mockReturnValue([{ rows: [] }]);
    expect(() =>
      upsertObjectAndEnqueue({
        upsertInput: { id: "abc", type: "test", data: {}, orgId: "org-tenant-b" },
        operation: "upsert",
      }),
    ).toThrow(/no row returned/);
    // The CTE ensures only one query ran; outbox INSERT is conditional on an upserted row.
    expect(runPg.mock.calls[0][0].queries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// getObjectById (org-scoped, deleted-aware)
// ---------------------------------------------------------------------------

describe("getObjectById (org-scoped, deleted-aware)", () => {
  beforeEach(() => {
    runPg.mockReset();
  });

  it("Test 3a: returns null when no rows", () => {
    runPg.mockReturnValue([{ rows: [] }]);
    const result = getObjectById("abc", { orgId: "org-1" });
    expect(result).toBeNull();
  });

  it("Test 3b: returns mapped record when row present", () => {
    runPg.mockReturnValue([{ rows: [baseRow()] }]);
    const result = getObjectById("abc", { orgId: "org-1" });
    expect(result).not.toBeNull();
    expect(result?.id).toBe("abc");
  });

  it("Test 4: SQL enforces org_id and deleted_at IS NULL", () => {
    runPg.mockReturnValue([{ rows: [] }]);
    getObjectById("abc", { orgId: "org-1" });
    const sql = runPg.mock.calls[0][0].queries[0].text;
    expect(sql).toMatch(/org_id\s*=\s*\$2\s+OR\s+\$2\s+IS\s+NULL/i);
    expect(sql).toMatch(/deleted_at\s+IS\s+NULL/i);
  });
});

// ---------------------------------------------------------------------------
// listObjectsByFilter (org-scoped)
// ---------------------------------------------------------------------------

describe("listObjectsByFilter (org-scoped)", () => {
  beforeEach(() => {
    runPg.mockReset();
  });

  it("Test 5: with ids[] uses ANY($n) and includes org_id filter", () => {
    runPg.mockReturnValue([{ rows: [] }]);
    listObjectsByFilter({ orgId: "org-1", ids: ["a", "b"] });
    const sql = runPg.mock.calls[0][0].queries[0].text;
    expect(sql).toMatch(/id\s*=\s*ANY\s*\(\s*\$\d+\s*::\s*text\[\]\s*\)/i);
    expect(sql).toMatch(/org_id\s*=\s*\$\d+\s+OR\s+\$\d+\s+IS\s+NULL/i);
  });

  // cinatra#1378 — the memory-sync preflight's batch key lookup.
  it("compiles externalIds into a parameterized ANY() over data->>'externalId'", () => {
    runPg.mockReturnValue([{ rows: [] }]);
    listObjectsByFilter({
      orgId: "org-1",
      type: "@cinatra-ai/memory:concept",
      externalIds: ["aa", "bb"],
    });
    const query = runPg.mock.calls[0][0].queries[0];
    expect(query.text).toMatch(
      /data->>'externalId'\s*=\s*ANY\s*\(\s*\$\d+\s*::\s*text\[\]\s*\)/i,
    );
    // The batch VALUE is parameterized; only the fixed key literal is inline.
    expect(query.values).toContainEqual(["aa", "bb"]);
    // And it never replaces the org / type narrowing — it ANDs with them.
    expect(query.text).toMatch(/org_id\s*=\s*\$\d+/i);
    expect(query.text).toMatch(/type\s*=\s*\$\d+/i);
  });

  it("treats an EMPTY externalIds array as no filter, never as `= ANY({})`", () => {
    // `= ANY('{}')` matches nothing, so a filter that quietly compiled to it
    // would report every present row as absent — and a sync run reads absent
    // as "create". The primitive schema refuses an empty batch outright; the
    // store simply does not emit a clause it was given nothing for.
    runPg.mockReturnValue([{ rows: [] }]);
    listObjectsByFilter({ orgId: "org-1", type: "t", externalIds: [] });
    expect(runPg.mock.calls[0][0].queries[0].text).not.toMatch(/externalId/);
  });

  it("throws rather than silently truncating an over-cap batch", () => {
    runPg.mockReturnValue([{ rows: [] }]);
    expect(() =>
      listObjectsByFilter({
        orgId: "org-1",
        type: "t",
        externalIds: Array.from({ length: MAX_EXTERNAL_IDS_BATCH + 1 }, (_v, i) => `id-${i}`),
      }),
    ).toThrow(new RegExp(`exceeds the ${MAX_EXTERNAL_IDS_BATCH} cap`));
    expect(runPg).not.toHaveBeenCalled();
  });

  // The claim `MAX_EXTERNAL_IDS_BATCH`'s own doc comment makes: the store cap
  // and the primitive's two bounds are PINNED equal, not left to agree by
  // coincidence. A batch that could ask for more rows than one call can return
  // would report present rows as absent, and a sync run reads absent as
  // "create" — a duplicate write. Both schema bounds are DISCOVERED by probing
  // rather than restated as a literal, so raising one number in isolation
  // fails here instead of passing quietly.
  it("pins the store cap equal to the primitive's batch AND limit ceilings", () => {
    const batchAccepts = (n: number) =>
      objectsListSchema.safeParse({
        type: "t",
        externalIds: Array.from({ length: n }, (_v, i) => `id-${i}`),
      }).success;
    expect(batchAccepts(MAX_EXTERNAL_IDS_BATCH)).toBe(true);
    expect(batchAccepts(MAX_EXTERNAL_IDS_BATCH + 1)).toBe(false);

    const limitAccepts = (n: number) =>
      objectsListSchema.safeParse({ type: "t", limit: n }).success;
    expect(limitAccepts(MAX_EXTERNAL_IDS_BATCH)).toBe(true);
    expect(limitAccepts(MAX_EXTERNAL_IDS_BATCH + 1)).toBe(false);
  });

  it("Test 6: returns rows in the same order they came back", () => {
    runPg.mockReturnValue([
      {
        rows: [
          baseRow({ id: "b" }),
          baseRow({ id: "a" }),
        ],
      },
    ]);
    const rows = listObjectsByFilter({ orgId: "org-1", ids: ["b", "a"] });
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
  });
});

// ---------------------------------------------------------------------------
// softDeleteObject (atomic with outbox, conditional CTE)
// ---------------------------------------------------------------------------

describe("softDeleteObject (atomic with outbox, conditional CTE)", () => {
  beforeEach(() => {
    runPg.mockReset();
    runPg.mockReturnValue([{ rows: [] }]);
  });

  it("Test 7: single CTE statement — UPDATE + INSERT FROM deleted CTE", () => {
    softDeleteObject("abc", { orgId: "org-1" });
    expect(runPg).toHaveBeenCalledOnce();
    const callArg = runPg.mock.calls[0][0];
    expect(callArg.transaction).toBe(true);
    expect(callArg.queries).toHaveLength(1); // single CTE statement
    const sql = callArg.queries[0].text;
    expect(sql).toMatch(/^\s*WITH\s+/i); // single WITH-CTE statement
    // The soft-delete UPDATE lives in the `deleted` CTE. A `base_row` snapshot
    // CTE now precedes it (captures the pre-delete payload for the atomic
    // object_change_event history row), so `deleted` is no longer the FIRST CTE.
    expect(sql).toMatch(/\bdeleted\s+AS\s*\(\s*UPDATE\b/i);
    expect(sql).toMatch(/SET\s+deleted_at\s*=\s*now\(\)/i);
    expect(sql).toMatch(/RETURNING/i);
    expect(sql).toContain("graphiti_projection_outbox");
    expect(sql).toMatch(/SELECT[\s\S]+FROM\s+deleted/i); // outbox INSERT reads from CTE
    expect(sql).toContain("'delete'");
  });

  it("Test 7b: outbox NOT emitted when no row matches (wrong orgId)", () => {
    // The SQL itself enforces this via `INSERT … SELECT FROM deleted` — when
    // the UPDATE matches zero rows, the CTE is empty and INSERT is a no-op.
    softDeleteObject("abc", { orgId: "org-other" });
    const sql = runPg.mock.calls[0][0].queries[0].text;
    expect(sql).not.toMatch(/INSERT\s+INTO[\s\S]+graphiti_projection_outbox[\s\S]+VALUES\s*\(/i);
    expect(sql).toMatch(/INSERT\s+INTO[\s\S]+graphiti_projection_outbox[\s\S]+SELECT[\s\S]+FROM\s+deleted/i);
  });

  it("Test 7c: double soft-delete issues only one runPg call and emits no second outbox row", () => {
    // Verify the already-deleted path produces zero outbox rows.
    // When deleted_at IS NOT NULL the UPDATE WHERE clause (AND deleted_at IS NULL)
    // matches zero rows → the CTE `deleted` is empty → INSERT INTO outbox
    // SELECT FROM deleted produces 0 rows. The SQL is issued once; no second
    // call is made for a "failsafe" insert.
    runPg.mockReturnValueOnce([{ rows: [] }]); // UPDATE matched 0 rows (already deleted)
    softDeleteObject("already-gone", { orgId: "org-1" });
    expect(runPg).toHaveBeenCalledOnce();
    const callArg = runPg.mock.calls[0][0];
    // Single CTE — no second query
    expect(callArg.queries).toHaveLength(1);
    // The CTE uses SELECT FROM deleted, so if deleted is empty the outbox INSERT
    // is a no-op at the DB level. Confirm the SQL shape is correct.
    expect(callArg.queries[0].text).toMatch(/SELECT[\s\S]+FROM\s+deleted/i);
  });
});

// ---------------------------------------------------------------------------
// upsertObjectAndEnqueue — explicit project binding (cinatra#1377, epic #1373)
//
// The row is TAGGED with the bound project at INSERT time. That tag is the half
// this issue adds; the OTHER half — the sealed-room list re-filter that turns the
// tag into "visible inside that project and only there" (`AND project_id =
// $projectId`) — is pre-existing and stays pinned where it lives, in
// `src/lib/__tests__/sealed-room.test.ts` ("listObjectsByFilter project mode").
// `project_id` is the LAST value in the CTE's leading positional block ($18).
// ---------------------------------------------------------------------------

describe("upsertObjectAndEnqueue — explicit project binding (cinatra#1377)", () => {
  const PROJECT_ID_PARAM_INDEX = 17; // $18, zero-based

  function projectIdWritten() {
    return runPg.mock.calls[0][0].queries[0].values[PROJECT_ID_PARAM_INDEX];
  }

  function withAmbientFrame<T>(projectId: string | null, fn: () => T): T {
    const als = mcpRequestContextStorage as unknown as {
      run: (store: unknown, fn: () => T) => T;
    };
    return als.run({ projectContext: { projectId } }, fn);
  }

  beforeEach(() => {
    runPg.mockReset();
    runPg.mockReturnValue([{ rows: [baseRow({ project_id: "prj-bound" })] }]);
  });

  it("an explicit id is written to objects.project_id", () => {
    upsertObjectAndEnqueue({
      upsertInput: { id: "abc", type: "test", data: {}, orgId: "org-1" },
      operation: "upsert",
      explicitProjectBinding: "prj-bound",
    });
    expect(projectIdWritten()).toBe("prj-bound");
  });

  it("an explicit id WINS over an active ambient frame", () => {
    withAmbientFrame("prj-ambient", () =>
      upsertObjectAndEnqueue({
        upsertInput: { id: "abc", type: "test", data: {}, orgId: "org-1" },
        operation: "upsert",
        explicitProjectBinding: "prj-bound",
      }),
    );
    expect(projectIdWritten()).toBe("prj-bound");
  });

  it("an explicit null writes NULL even inside an ambient frame (substrate write)", () => {
    withAmbientFrame("prj-ambient", () =>
      upsertObjectAndEnqueue({
        upsertInput: { id: "abc", type: "test", data: {}, orgId: "org-1" },
        operation: "upsert",
        explicitProjectBinding: null,
      }),
    );
    expect(projectIdWritten()).toBeNull();
  });

  it("an OMITTED binding leaves ambient inheritance untouched", () => {
    withAmbientFrame("prj-ambient", () =>
      upsertObjectAndEnqueue({
        upsertInput: { id: "abc", type: "test", data: {}, orgId: "org-1" },
        operation: "upsert",
      }),
    );
    expect(projectIdWritten()).toBe("prj-ambient");
  });

  it("an explicit binding still cannot project a SUBSTRATE type", () => {
    upsertObjectAndEnqueue({
      upsertInput: {
        id: "abc",
        type: "@cinatra-ai/entity-contacts:contact",
        data: {},
        orgId: "org-1",
      },
      operation: "upsert",
      explicitProjectBinding: "prj-bound",
    });
    expect(projectIdWritten()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// upsertObjectAndEnqueue — collision guard (cinatra#1377)
//
// The `objects_save` handler probes `object.update` against the existing row
// before writing. The probe and the write are separate statements, so the guard
// is what makes that authorization BINDING: the DO UPDATE arm is pinned to the
// exact row state the probe saw, and anything else refuses.
// ---------------------------------------------------------------------------

describe("upsertObjectAndEnqueue — collision guard (cinatra#1377)", () => {
  const GUARD_ARMED = 24; // $25, zero-based
  const EXPECTED_VERSION = 25; // $26
  const EXPECTED_PROJECT = 26; // $27

  function values() {
    return runPg.mock.calls[0][0].queries[0].values;
  }
  function sql() {
    return runPg.mock.calls[0][0].queries[0].text;
  }

  beforeEach(() => {
    runPg.mockReset();
    runPg.mockReturnValue([{ rows: [baseRow()] }]);
  });

  it("is INERT when the caller does not arm it (existing writers unchanged)", () => {
    upsertObjectAndEnqueue({
      upsertInput: { id: "abc", type: "test", data: {}, orgId: "org-1" },
      operation: "upsert",
    });
    expect(values()[GUARD_ARMED]).toBe(false);
    expect(values()[EXPECTED_VERSION]).toBeNull();
    expect(values()[EXPECTED_PROJECT]).toBeNull();
  });

  it("pins the DO UPDATE arm to the authorized version AND project when armed", () => {
    upsertObjectAndEnqueue({
      upsertInput: { id: "abc", type: "test", data: {}, orgId: "org-1" },
      operation: "upsert",
      collisionGuard: { expectedVersion: 7, expectedProjectId: "prj-open" },
    });
    expect(values()[GUARD_ARMED]).toBe(true);
    expect(values()[EXPECTED_VERSION]).toBe(7);
    expect(values()[EXPECTED_PROJECT]).toBe("prj-open");
    // The guard rides the DO UPDATE WHERE, so it can never block an INSERT.
    expect(sql()).toContain("$25::boolean IS NOT TRUE");
    expect(sql()).toContain('"objects".version = $26::int');
    expect(sql()).toContain("IS NOT DISTINCT FROM $27::text");
  });

  it("arms with a NULL expectedVersion when the caller authorized a CREATE", () => {
    upsertObjectAndEnqueue({
      upsertInput: { id: "abc", type: "test", data: {}, orgId: "org-1" },
      operation: "upsert",
      collisionGuard: { expectedVersion: null, expectedProjectId: null },
    });
    expect(values()[GUARD_ARMED]).toBe(true);
    expect(values()[EXPECTED_VERSION]).toBeNull();
  });

  // The org predicate and the collision guard both produce an empty RETURNING,
  // and nothing outside the failed statement can tell them apart — a later
  // re-read would answer about a newer snapshot than the one that blocked the
  // write. So the writer claims only what is certain: the precondition did not
  // hold and nothing was written. One statement, no classification query.
  it("a blocked guard refuses with the precondition code and writes nothing", () => {
    runPg.mockReturnValue([{ rows: [] }]);
    let thrown: (Error & { code?: string }) | null = null;
    try {
      upsertObjectAndEnqueue({
        upsertInput: { id: "abc", type: "test", data: {}, orgId: "org-1" },
        operation: "upsert",
        collisionGuard: { expectedVersion: 7, expectedProjectId: null },
      });
    } catch (err) {
      thrown = err as Error & { code?: string };
    }
    expect(thrown?.code).toBe("OBJECTS_WRITE_PRECONDITION_FAILED");
    // No second query: the refusal is decided from the failed statement alone.
    expect(runPg).toHaveBeenCalledTimes(1);
  });

  it("the refusal names BOTH possible causes rather than guessing one", () => {
    runPg.mockReturnValue([{ rows: [] }]);
    let thrown: Error | null = null;
    try {
      upsertObjectAndEnqueue({
        upsertInput: { id: "abc", type: "test", data: {}, orgId: "org-1" },
        operation: "upsert",
        collisionGuard: { expectedVersion: 7, expectedProjectId: null },
      });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown?.message).toMatch(/changed between the caller's authorization probe/);
    expect(thrown?.message).toMatch(/cross-tenant collision/);
  });

  it("an UNARMED caller keeps the original cross-tenant message", () => {
    runPg.mockReturnValue([{ rows: [] }]);
    let thrown: (Error & { code?: string }) | null = null;
    try {
      upsertObjectAndEnqueue({
        upsertInput: { id: "abc", type: "test", data: {}, orgId: "org-1" },
        operation: "upsert",
      });
    } catch (err) {
      thrown = err as Error & { code?: string };
    }
    expect(thrown?.message).toMatch(/cross-tenant collision/);
    expect(thrown?.code).toBeUndefined();
  });
});
