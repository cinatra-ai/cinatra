// SQL-shape unit tests for the binding write path (cinatra#1429). The postgres
// runner is mocked; we assert the emitted SQL / params / transaction boundaries
// carry the safety properties. Live-DB behavior (all 5 ACs) is proven by
// binding-write-path.integration.test.ts on the verify stack.

import { beforeEach, describe, expect, it, vi } from "vitest";

const runPostgresQueriesSync = vi.fn();
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...a: unknown[]) => runPostgresQueriesSync(...a),
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));
vi.mock("@/lib/postgres-config", () => ({
  postgresSchema: "cinatra",
  getPostgresConnectionString: () => "postgres://test",
}));

import {
  BINDING_ASSERTED_BY,
  buildBindingReconcileQueries,
  reconcileArtifactBinding,
} from "@/lib/objects/binding-write-path";

beforeEach(() => runPostgresQueriesSync.mockReset());

describe("buildBindingReconcileQueries", () => {
  const [archive, insert] = buildBindingReconcileQueries("cinatra", {
    orgId: "o1",
    artifactId: "a1",
    newBindingId: "b-new",
  });

  it("emits exactly two statements: archive-stale then insert-winner", () => {
    expect(buildBindingReconcileQueries("cinatra", { orgId: "o", artifactId: "a" })).toHaveLength(2);
  });

  it("bindings are asserted_by 'system'", () => {
    expect(BINDING_ASSERTED_BY).toBe("system");
    expect(insert.text).toMatch(/'system'/);
    expect(insert.text).toMatch(/'binding'/);
  });

  it("archive targets only active BINDING rows that do not match the current winner", () => {
    expect(archive.text).toMatch(/UPDATE "cinatra"\."semantic_assertion"[\s\S]*SET eligibility = 'archived'/);
    expect(archive.text).toMatch(/assertion_basis = 'binding' AND sa\.eligibility <> 'archived'/);
    expect(archive.text).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM winner w/);
    expect(archive.values).toEqual(["o1", "a1"]);
  });

  it("the winner CTE resolves the DEDICATED claim, org-scope over platform, gen DESC/id ASC, excluding quarantined", () => {
    for (const t of [archive.text, insert.text]) {
      expect(t).toMatch(/claim_kind = 'dedicated'/);
      expect(t).toMatch(/c\.status IN \('active','retiring'\)/);
      expect(t).toMatch(/c\.scope = 'platform' OR c\.scope = 'org:' \|\| \$1/);
      expect(t).toMatch(/ORDER BY \(CASE WHEN c\.scope = 'org:' \|\| \$1 THEN 0 ELSE 1 END\) ASC,[\s\S]*c\.generation DESC, c\.id ASC/);
      expect(t).toMatch(/object_binding_quarantine/);
    }
  });

  it("insert is idempotent: guarded by NOT EXISTS a matching active binding; RETURNING id", () => {
    expect(insert.text).toMatch(/INSERT INTO "cinatra"\."semantic_assertion"/);
    expect(insert.text).toMatch(/WHERE NOT EXISTS \(\s*SELECT 1 FROM "cinatra"\."semantic_assertion" sa2[\s\S]*binding_claim_id = w\.claim_id/);
    expect(insert.text).toMatch(/RETURNING id/);
    expect(insert.values).toEqual(["o1", "a1", "b-new"]);
  });
});

describe("reconcileArtifactBinding", () => {
  it("runs at REPEATABLE READ then takes the per-artifact advisory lock, one consistent-snapshot tx", () => {
    runPostgresQueriesSync.mockReturnValue([
      { rows: [], rowCount: 0 }, // SET
      { rows: [], rowCount: 0 }, // lock
      { rows: [], rowCount: 0 }, // archive
      { rows: [{ id: "b" }], rowCount: 1 }, // insert
    ]);
    const res = reconcileArtifactBinding({ orgId: "o1", artifactId: "a1" });
    const call = runPostgresQueriesSync.mock.calls[0][0];
    expect(call.transaction).toBe(true);
    expect(call.queries[0].text).toBe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    expect(call.queries[1].text).toBe("SELECT pg_advisory_xact_lock(hashtext($1))");
    expect(call.queries[1].values).toEqual(["a1"]);
    expect(call.queries).toHaveLength(4); // SET + lock + archive + insert
    expect(res).toEqual({ archived: 0, inserted: 1, changed: true });
  });

  it("reports archived + inserted counts and changed=false on a no-op", () => {
    runPostgresQueriesSync.mockReturnValue([
      { rows: [], rowCount: 0 }, // SET
      { rows: [], rowCount: 0 }, // lock
      { rows: [], rowCount: 0 }, // archive
      { rows: [], rowCount: 0 }, // insert
    ]);
    expect(reconcileArtifactBinding({ orgId: "o", artifactId: "a" })).toEqual({
      archived: 0,
      inserted: 0,
      changed: false,
    });
  });
});
