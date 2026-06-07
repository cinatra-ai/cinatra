// findLatestUndoableChangeSetForObject coverage.
//
// The helper's filtering happens in SQL (the test suite mocks
// runPostgresQueriesSync rather than standing up a live PG — same pattern
// as version-restore-deleted-state.test.ts). So we cover the five required
// dimensions by pinning that the constructed query carries each filter
// clause + the correct $-ordered values, plus the JS behaviours (orgless
// short-circuit, empty → null, row → mapped result). A future edit that
// silently drops `closed_at IS NOT NULL`, `actor_id`, `object_id`, the
// freshness bound, or `restorable = true` fails here.

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  runQueries: vi.fn(),
}));

vi.mock("@/lib/database", () => ({
  ensurePostgresSchema: () => {},
  getPostgresConnectionString: () => "postgresql://test",
  postgresSchema: "test_schema",
}));

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: mocks.runQueries,
}));

// server-views also imports object-history + authz; those aren't exercised
// by findLatestUndoableChangeSetForObject, so stub the object-history barrel
// to avoid pulling the full substrate into the unit test.
vi.mock("@/lib/object-history", () => ({
  readObjectScopeById: vi.fn(),
}));

import { findLatestUndoableChangeSetForObject } from "../server-views";

const BASE_INPUT = {
  orgId: "org_1",
  objectId: "obj_1",
  actorId: "user_1",
  openedAfter: "2026-05-23T20:00:00.000Z",
};

function lastQuery(): { text: string; values: unknown[] } {
  const call = mocks.runQueries.mock.calls.at(-1)?.[0] as {
    queries: Array<{ text: string; values: unknown[] }>;
  };
  return call.queries[0];
}

describe("findLatestUndoableChangeSetForObject", () => {
  beforeEach(() => {
    mocks.runQueries.mockReset();
    mocks.runQueries.mockReturnValue([{ rows: [], rowCount: 0 }]);
  });

  it("returns null for an orgless caller WITHOUT querying (fail-closed)", () => {
    const result = findLatestUndoableChangeSetForObject({
      ...BASE_INPUT,
      orgId: null,
    });
    expect(result).toBeNull();
    expect(mocks.runQueries).not.toHaveBeenCalled();
  });

  it("returns null when no row matches (empty result set)", () => {
    const result = findLatestUndoableChangeSetForObject(BASE_INPUT);
    expect(result).toBeNull();
  });

  it("maps a found row to { changeSetId, restorable }", () => {
    mocks.runQueries.mockReturnValue([
      { rows: [{ id: "cs_42", opened_at: "x", restorable: true }], rowCount: 1 },
    ]);
    const result = findLatestUndoableChangeSetForObject(BASE_INPUT);
    expect(result).toEqual({ changeSetId: "cs_42", restorable: true });
  });

  it("passes [orgId, actorId, openedAfter, objectId] as $1..$4 in order", () => {
    findLatestUndoableChangeSetForObject(BASE_INPUT);
    expect(lastQuery().values).toEqual([
      "org_1",
      "user_1",
      "2026-05-23T20:00:00.000Z",
      "obj_1",
    ]);
  });

  describe("required filter clauses (the five dimensions)", () => {
    beforeEach(() => {
      findLatestUndoableChangeSetForObject(BASE_INPUT);
    });

    it("freshness window: opened_at > $3 (inside/outside window)", () => {
      expect(lastQuery().text).toMatch(/cs\.opened_at\s*>\s*\$3::timestamptz/);
    });

    it("actor scope: actor_id = $2 (wrong actor → no match)", () => {
      expect(lastQuery().text).toMatch(/cs\.actor_id\s*=\s*\$2/);
    });

    it("actor-kind fail-closed: actor_kind = 'user' (legacy 'system' rows never surface as 'your last change')", () => {
      expect(lastQuery().text).toMatch(/cs\.actor_kind\s*=\s*'user'/);
    });

    it("object scope: joined object_change_event.object_id = $4 (wrong object → no match)", () => {
      expect(lastQuery().text).toMatch(
        /JOIN\s+"test_schema"\."object_change_event"\s+oce\s+ON\s+oce\.change_set_id\s*=\s*cs\.id/,
      );
      expect(lastQuery().text).toMatch(/oce\.object_id\s*=\s*\$4/);
    });

    it("closed-only: closed_at IS NOT NULL (open change-sets not undoable)", () => {
      expect(lastQuery().text).toMatch(/cs\.closed_at\s+IS\s+NOT\s+NULL/);
    });

    it("restorable gate: restorable = true", () => {
      expect(lastQuery().text).toMatch(/cs\.restorable\s*=\s*true/);
    });

    it("org scope: org_id = $1", () => {
      expect(lastQuery().text).toMatch(/cs\.org_id\s*=\s*\$1/);
    });

    it("newest-first + single row: ORDER BY opened_at DESC + LIMIT 1", () => {
      expect(lastQuery().text).toMatch(
        /ORDER BY cs\.opened_at DESC, cs\.id DESC\s+LIMIT 1/,
      );
    });

    it("DISTINCT to dedupe the multi-event join", () => {
      expect(lastQuery().text).toMatch(/SELECT DISTINCT cs\.id/);
    });
  });
});
