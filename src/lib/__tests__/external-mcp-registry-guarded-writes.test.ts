// TOCTOU-safe registry helpers (Refs cinatra#658).
//
// The privileged write actions for external MCP servers used to read the row
// through the in-process 30s TTL cache (`getExternalMcpServerById`) and then
// write UNCONDITIONALLY by id. Under cross-worker cache staleness + a concurrent
// admin promotion, that let a non-admin overwrite/delete a now-global row.
//
// These prove the registry-level fix at the SQL boundary, with the sync Postgres
// driver mocked (no live DB needed — the load-bearing behavior is the emitted SQL
// guard clauses + the rowCount→conflict mapping):
//   - `getExternalMcpServerByIdFresh` issues a direct single-row SELECT (never the
//     cached list) and does NOT populate the cache;
//   - `insertExternalMcpServerStrict` uses ON CONFLICT DO NOTHING and throws a
//     conflict on a zero-row result (never clobbers an existing id);
//   - `updateExternalMcpServerGuarded` / `deleteExternalMcpServerGuarded` carry a
//     `scope = $ AND user_id IS NOT DISTINCT FROM $` guard and throw a conflict on
//     a zero-row match (the row changed/vanished under the authorized operation).

import { describe, it, expect, vi, beforeEach } from "vitest";

type QueryCall = { text: string; values?: unknown[] };
let lastQueries: QueryCall[] = [];
// What the mocked driver returns for the NEXT call.
let nextResult: { rows: Array<Record<string, unknown>>; rowCount: number } = { rows: [], rowCount: 0 };

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (input: { queries: QueryCall[] }) => {
    lastQueries = input.queries;
    return [nextResult];
  },
}));

// `@/lib/database` resolves to tests/__stubs__/database.ts (inert) via the root
// vitest alias, so no real connection string / schema bootstrap is required.

const {
  getExternalMcpServerByIdFresh,
  insertExternalMcpServerStrict,
  updateExternalMcpServerGuarded,
  deleteExternalMcpServerGuarded,
  ExternalMcpServerWriteConflictError,
} = await import("@/lib/external-mcp-registry");

const baseInput = {
  id: "row-1",
  label: "L",
  serverUrl: "https://example/mcp",
  nangoConnectionId: null,
  scope: "user" as const,
  orgId: null,
  userId: "u1" as string | null,
  enabled: true,
};

beforeEach(() => {
  lastQueries = [];
  nextResult = { rows: [], rowCount: 0 };
});

describe("getExternalMcpServerByIdFresh", () => {
  it("issues a direct single-row SELECT by id (not the cached list)", () => {
    nextResult = {
      rows: [
        {
          id: "row-1",
          label: "L",
          server_url: "https://example/mcp",
          nango_connection_id: null,
          scope: "user",
          org_id: null,
          user_id: "u1",
          enabled: true,
          allowed_tools: null,
          allowed_catalog_tools: null,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      rowCount: 1,
    };
    const row = getExternalMcpServerByIdFresh("row-1");
    expect(row?.id).toBe("row-1");
    expect(row?.scope).toBe("user");
    expect(lastQueries).toHaveLength(1);
    expect(lastQueries[0].text).toMatch(/WHERE id = \$1/);
    expect(lastQueries[0].text).toMatch(/LIMIT 1/);
    expect(lastQueries[0].values).toEqual(["row-1"]);
  });

  it("returns null when the row does not exist", () => {
    nextResult = { rows: [], rowCount: 0 };
    expect(getExternalMcpServerByIdFresh("nope")).toBeNull();
  });
});

describe("insertExternalMcpServerStrict", () => {
  it("emits ON CONFLICT DO NOTHING ... RETURNING id and succeeds on a 1-row result", () => {
    nextResult = { rows: [{ id: "row-1" }], rowCount: 1 };
    expect(() => insertExternalMcpServerStrict(baseInput)).not.toThrow();
    expect(lastQueries[0].text).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
    expect(lastQueries[0].text).toMatch(/RETURNING id/);
    // No DO UPDATE clobber on conflict.
    expect(lastQueries[0].text).not.toMatch(/DO UPDATE/);
  });

  it("throws a write-conflict when the id already exists (zero rows inserted)", () => {
    nextResult = { rows: [], rowCount: 0 };
    expect(() => insertExternalMcpServerStrict(baseInput)).toThrow(
      ExternalMcpServerWriteConflictError,
    );
  });
});

describe("updateExternalMcpServerGuarded", () => {
  it("guards on scope + user_id IS NOT DISTINCT FROM and succeeds on a 1-row match", () => {
    nextResult = { rows: [{ id: "row-1" }], rowCount: 1 };
    expect(() =>
      updateExternalMcpServerGuarded(baseInput, { scope: "user", userId: "u1" }),
    ).not.toThrow();
    const sql = lastQueries[0].text;
    expect(sql).toMatch(/^UPDATE /);
    expect(sql).toMatch(/WHERE id = \$1/);
    expect(sql).toMatch(/AND scope = \$11/);
    expect(sql).toMatch(/AND user_id IS NOT DISTINCT FROM \$12/);
    expect(sql).toMatch(/RETURNING id/);
    // The guard parameters are the WITNESSED scope+owner.
    const values = lastQueries[0].values as unknown[];
    expect(values[10]).toBe("user"); // $11
    expect(values[11]).toBe("u1"); // $12
  });

  it("throws a write-conflict when the row no longer matches the witnessed guard (zero rows)", () => {
    nextResult = { rows: [], rowCount: 0 };
    expect(() =>
      updateExternalMcpServerGuarded(baseInput, { scope: "user", userId: "u1" }),
    ).toThrow(ExternalMcpServerWriteConflictError);
  });

  it("passes a NULL expected owner through for a global/shared guard", () => {
    nextResult = { rows: [{ id: "row-1" }], rowCount: 1 };
    updateExternalMcpServerGuarded(
      { ...baseInput, scope: "global", userId: null },
      { scope: "global", userId: null },
    );
    const values = lastQueries[0].values as unknown[];
    expect(values[10]).toBe("global");
    expect(values[11]).toBeNull();
  });
});

describe("deleteExternalMcpServerGuarded", () => {
  it("guards the DELETE on scope + user_id IS NOT DISTINCT FROM and succeeds on a 1-row match", () => {
    nextResult = { rows: [{ id: "row-1" }], rowCount: 1 };
    expect(() =>
      deleteExternalMcpServerGuarded("row-1", { scope: "user", userId: "u1" }),
    ).not.toThrow();
    const sql = lastQueries[0].text;
    expect(sql).toMatch(/^DELETE FROM/);
    expect(sql).toMatch(/WHERE id = \$1/);
    expect(sql).toMatch(/AND scope = \$2/);
    expect(sql).toMatch(/AND user_id IS NOT DISTINCT FROM \$3/);
    expect(sql).toMatch(/RETURNING id/);
    expect(lastQueries[0].values).toEqual(["row-1", "user", "u1"]);
  });

  it("throws a write-conflict when the row changed/vanished under the guard (zero rows)", () => {
    nextResult = { rows: [], rowCount: 0 };
    expect(() =>
      deleteExternalMcpServerGuarded("row-1", { scope: "user", userId: "u1" }),
    ).toThrow(ExternalMcpServerWriteConflictError);
  });
});
