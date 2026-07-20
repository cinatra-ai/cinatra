// cinatra#1456 — the indexed `dataEquals` correlation filter on
// listObjectsByFilter (src/lib/objects-store.ts). Unit-level: mocks
// @/lib/postgres-sync to capture the SQL + values without a real PG instance.
//
// Proves:
//   - each allow-listed key compiles to a parameterized `data->>'<key>' = $n`
//     clause spliced into the WHERE, in filter order, with the value bound
//     positionally (never interpolated);
//   - multiple entries AND together (contact view = connectorId AND contactId);
//   - a non-allow-listed / malformed key THROWS (the interpolated-key injection
//     guard) — never a silently-dropped clause that would widen the read;
//   - compileDataEqualsClause is a pure, testable unit of the same behavior.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: vi.fn(() => [{ rows: [] }]),
}));

vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => "postgres://test",
  ensurePostgresSchema: () => undefined,
  postgresSchema: "cinatra",
}));

// Sealed-room off so no project clause muddies the captured SQL.
vi.mock("@/lib/sealed-room", () => ({
  sealedRoomFilterValue: () => null,
}));

import {
  listObjectsByFilter,
  compileDataEqualsClause,
  DATA_EQUALS_ALLOWED_KEYS,
} from "@/lib/objects-store";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

const runPg = runPostgresQueriesSync as unknown as ReturnType<typeof vi.fn>;

function lastQuery(): { text: string; values: unknown[] } {
  const call = runPg.mock.calls.at(-1)?.[0] as { queries: Array<{ text: string; values: unknown[] }> };
  return call.queries[0];
}

beforeEach(() => {
  runPg.mockClear();
  runPg.mockReturnValue([{ rows: [] }]);
});

describe("listObjectsByFilter dataEquals — indexed data.* correlation filter", () => {
  it("compiles a single allow-listed key to a parameterized data->> clause", () => {
    listObjectsByFilter({
      orgId: "org-1",
      type: "@cinatra-ai/email:sent-email",
      dataEquals: [{ key: "threadId", value: "conn-a:pt-9" }],
    });
    const { text, values } = lastQuery();
    expect(text).toContain("data->>'threadId' = $");
    // org($1) + type($2) + threadId($3)
    expect(text).toContain("data->>'threadId' = $3");
    expect(values).toEqual(["org-1", "@cinatra-ai/email:sent-email", "conn-a:pt-9"]);
  });

  it("ANDs multiple entries in order (contact view = connectorId + contactId)", () => {
    listObjectsByFilter({
      orgId: "org-1",
      type: "@cinatra-ai/email:sent-email",
      dataEquals: [
        { key: "connectorId", value: "conn-a" },
        { key: "contactId", value: "c-77" },
      ],
    });
    const { text, values } = lastQuery();
    expect(text).toContain("data->>'connectorId' = $3");
    expect(text).toContain("data->>'contactId' = $4");
    expect(values).toEqual(["org-1", "@cinatra-ai/email:sent-email", "conn-a", "c-77"]);
  });

  it("binds the value positionally — a value that looks like SQL is never interpolated", () => {
    listObjectsByFilter({
      orgId: "org-1",
      dataEquals: [{ key: "campaignId", value: "'; DROP TABLE objects; --" }],
    });
    const { text, values } = lastQuery();
    expect(text).not.toContain("DROP TABLE");
    expect(values).toContain("'; DROP TABLE objects; --");
  });

  it("throws on a non-allow-listed key (interpolated-key injection guard)", () => {
    expect(() =>
      listObjectsByFilter({
        orgId: "org-1",
        dataEquals: [{ key: "subject", value: "x" }],
      }),
    ).toThrow(/not an allow-listed/);
  });

  it("rejects runId as a data.* key (run-scoped reads use the indexed run_id column, not a data scan)", () => {
    expect(() =>
      compileDataEqualsClause([{ key: "runId", value: "run-1" }], [], 2),
    ).toThrow(/not an allow-listed/);
  });

  it("throws on a malformed key even if it were allow-listed by string tricks", () => {
    expect(() =>
      compileDataEqualsClause([{ key: "threadId') = '' OR '1'='1", value: "x" }], [], 2),
    ).toThrow(/not an allow-listed/);
  });

  it("empty / absent dataEquals adds no clause", () => {
    expect(compileDataEqualsClause(undefined, [], 2)).toEqual({ clauses: [], nextIndex: 2 });
    expect(compileDataEqualsClause([], [], 5)).toEqual({ clauses: [], nextIndex: 5 });
  });

  it("compileDataEqualsClause advances the parameter index and appends values", () => {
    const values: unknown[] = ["org-1"];
    const { clauses, nextIndex } = compileDataEqualsClause(
      [
        { key: "threadId", value: "t" },
        { key: "campaignId", value: "c" },
      ],
      values,
      2,
    );
    expect(clauses).toEqual(["data->>'threadId' = $2", "data->>'campaignId' = $3"]);
    expect(nextIndex).toBe(4);
    expect(values).toEqual(["org-1", "t", "c"]);
  });

  it("the allow-list is exactly the indexed email correlation keys (no runId)", () => {
    expect([...DATA_EQUALS_ALLOWED_KEYS].sort()).toEqual([
      "campaignId",
      "connectorId",
      "contactId",
      "threadId",
    ]);
  });
});
