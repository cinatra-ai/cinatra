import { describe, it, expect, vi, beforeEach } from "vitest";

// SQL-shape proof for the lifecycle DB write primitives (cinatra#1361). No real
// Postgres here — the postgres runner is mocked and we assert the emitted SQL /
// params carry the safety properties codex-round-1 required.
const runPostgresQueriesSync = vi.fn();
vi.mock("@/lib/postgres-sync", () => ({ runPostgresQueriesSync: (...a: unknown[]) => runPostgresQueriesSync(...a) }));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));
vi.mock("@/lib/postgres-config", () => ({
  postgresSchema: "cinatra",
  getPostgresConnectionString: () => "postgres://test",
}));

import {
  applySkillLifecycleTransitionInDatabase,
  buildSkillLifecycleRevisionQueries,
  recordSkillRevisionInDatabase,
} from "@/lib/skill-lifecycle-store";

beforeEach(() => runPostgresQueriesSync.mockReset());

describe("buildSkillLifecycleRevisionQueries", () => {
  it("emits a PLAIN revision INSERT (no ON CONFLICT) then an init/pointer UPDATE, ordered", () => {
    const [insert, update] = buildSkillLifecycleRevisionQueries("cinatra", [
      {
        skillId: "s1", revisionId: "r1", contentDigest: "sha", source: "manual",
        basedOnSkillIds: ["b1"], baseDigests: { b1: "d1" }, authorUserId: "u1", initialState: "active",
      },
    ]);
    expect(insert.text).toMatch(/INSERT INTO "cinatra"\."skill_revisions"/);
    expect(insert.text).not.toMatch(/ON CONFLICT/); // collisions must ABORT, not silently no-op
    expect(insert.values?.[0]).toBe("r1");
    // pointer UPDATE preserves an existing state (COALESCE) and moves the pointer
    expect(update.text).toMatch(/SET lifecycle_state = COALESCE\(lifecycle_state, \$2\)/);
    expect(update.text).toMatch(/active_revision_id = \$3/);
    expect(update.values).toEqual(["s1", "active", "r1"]);
  });
});

describe("applySkillLifecycleTransitionInDatabase — race-free CAS + cycle guard", () => {
  it("locks the supersede graph then runs a CAS + WITH RECURSIVE cycle guard + conditional audit", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [] }, { rows: [{ id: "audit1" }] }]);
    const out = applySkillLifecycleTransitionInDatabase({
      skillId: "a", expectedFrom: "active", to: "deprecated", supersededBy: "b",
      auditId: "audit1", actorUserId: "u1", actorType: "user", reason: "x",
    });
    expect(out).toEqual({ changed: true });
    const { queries } = runPostgresQueriesSync.mock.calls[0][0] as { queries: Array<{ text: string; values?: unknown[] }> };
    // 1) transaction-scoped advisory lock serializes supersede-graph mutations
    expect(queries[0].text).toMatch(/pg_advisory_xact_lock\('cinatra-skill-supersede-graph'\)|pg_advisory_xact_lock\(hashtext\('cinatra-skill-supersede-graph'\)\)/);
    const cas = queries[1].text;
    // 2) CAS on the expected prior state
    expect(cas).toMatch(/WHERE id = \$1 AND lifecycle_state = \$2/);
    // 3) DB-side acyclicity: recursive walk + self-edge + loop-back rejection
    expect(cas).toMatch(/WITH RECURSIVE walk\(id\) AS/);
    expect(cas).toMatch(/\$4 <> \$1 AND NOT EXISTS \(SELECT 1 FROM walk WHERE id = \$1\)/);
    // 4) audit written only when the swap matched
    expect(cas).toMatch(/INSERT INTO "cinatra"\."skill_lifecycle_audit"[\s\S]*SELECT \$5, \$1, \$2, \$3, \$6, \$7, \$8 FROM upd/);
  });

  it("reports changed=false (fail-closed no-op) when the CAS/cycle guard matched nothing", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [] }, { rows: [] }]);
    const out = applySkillLifecycleTransitionInDatabase({
      skillId: "a", expectedFrom: "active", to: "deprecated", auditId: "x",
    });
    expect(out).toEqual({ changed: false });
  });
});

describe("recordSkillRevisionInDatabase", () => {
  it("runs the revision queries in a transaction", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [] }, { rows: [] }]);
    recordSkillRevisionInDatabase({
      skillId: "s1", revisionId: "r1", contentDigest: null, source: "hitl",
      basedOnSkillIds: null, baseDigests: null, authorUserId: null, initialState: "active",
    });
    const arg = runPostgresQueriesSync.mock.calls[0][0] as { transaction?: boolean; queries: unknown[] };
    expect(arg.transaction).toBe(true);
    expect(arg.queries).toHaveLength(2);
  });
});
