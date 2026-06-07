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
  softDeleteObject,
  upsertObjectAndEnqueue,
} from "@/lib/objects-store";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

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
    expect(sql).toMatch(/WITH\s+deleted\s+AS/i);
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
