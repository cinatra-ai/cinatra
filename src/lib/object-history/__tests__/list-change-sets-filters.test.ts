// listChangeSets filter SQL-shape.
// Mocks the DB and pins each optional filter's WHERE clause +
// values, the objectId EXISTS subquery (not a row-multiplying
// join), and backward-compat (no filters → only org scope).

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ runQueries: vi.fn() }));
vi.mock("@/lib/database", () => ({
  ensurePostgresSchema: () => {},
  getPostgresConnectionString: () => "postgresql://test",
  postgresSchema: "test_schema",
}));
vi.mock("@/lib/postgres-sync", () => ({ runPostgresQueriesSync: mocks.runQueries }));

import { listChangeSets } from "../change-set";

function lastQuery() {
  const call = mocks.runQueries.mock.calls.at(-1)?.[0] as {
    queries: Array<{ text: string; values: unknown[] }>;
  };
  return call.queries[0];
}

describe("listChangeSets — filters", () => {
  beforeEach(() => {
    mocks.runQueries.mockReset();
    mocks.runQueries.mockReturnValue([{ rows: [] }]);
  });

  it("backward-compat: only orgId → single org_id clause, no filter columns", () => {
    listChangeSets({ orgId: "org_1" });
    const q = lastQuery();
    expect(q.text).toMatch(/org_id = \$1/);
    expect(q.text).not.toMatch(/actor_id =/);
    expect(q.text).not.toMatch(/EXISTS/);
    expect(q.values).toEqual(["org_1"]);
  });

  it("actorId → actor_id clause", () => {
    listChangeSets({ orgId: "org_1", actorId: "user_1" });
    expect(lastQuery().text).toMatch(/actor_id = \$2/);
    expect(lastQuery().values).toContain("user_1");
  });

  it("effectRollup → effect_rollup clause", () => {
    listChangeSets({ orgId: "org_1", effectRollup: "irreversible-logged" });
    expect(lastQuery().text).toMatch(/effect_rollup = \$/);
    expect(lastQuery().values).toContain("irreversible-logged");
  });

  it("restorable=false → restorable clause with the boolean value", () => {
    listChangeSets({ orgId: "org_1", restorable: false });
    expect(lastQuery().text).toMatch(/restorable = \$/);
    expect(lastQuery().values).toContain(false);
  });

  it("createdAfter / createdBefore → opened_at bounds with ::timestamptz casts", () => {
    listChangeSets({
      orgId: "org_1",
      createdAfter: "2026-05-01",
      createdBefore: "2026-05-31",
    });
    expect(lastQuery().text).toMatch(/opened_at > \$\d+::timestamptz/);
    expect(lastQuery().text).toMatch(/opened_at < \$\d+::timestamptz/);
  });

  it("closedAtAfter → closed_at lower bound (chat-undo polling)", () => {
    listChangeSets({ orgId: "org_1", closedAtAfter: "2026-05-23T20:00:00Z" });
    expect(lastQuery().text).toMatch(/closed_at > \$\d+::timestamptz/);
  });

  it("objectId → EXISTS subquery against object_change_event (not a join)", () => {
    listChangeSets({ orgId: "org_1", objectId: "obj_1" });
    const q = lastQuery();
    expect(q.text).toMatch(
      /EXISTS \(SELECT 1 FROM "test_schema"\."object_change_event" oce/,
    );
    expect(q.text).toMatch(/oce\.object_id = \$/);
    // EXISTS, never a row-multiplying JOIN to object_change_event.
    expect(q.text).not.toMatch(/JOIN "test_schema"\."object_change_event"/);
    expect(q.values).toContain("obj_1");
  });

  it("combined filters all appear together", () => {
    listChangeSets({
      orgId: "org_1",
      actorId: "user_1",
      restorable: true,
      objectId: "obj_1",
    });
    const t = lastQuery().text;
    expect(t).toMatch(/org_id = \$1/);
    expect(t).toMatch(/actor_id = \$2/);
    expect(t).toMatch(/restorable = \$3/);
    expect(t).toMatch(/EXISTS/);
  });
});
