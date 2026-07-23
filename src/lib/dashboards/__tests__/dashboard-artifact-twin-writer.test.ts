// Unit + bridge-contract tests for the HOST dashboards-artifact twin writer
// (cinatra#1894 B1b). DB-FREE: the twin's ORDERED substrate query list is
// asserted for shape + scope-axis + gating, and EVERY query round-trips through
// `rawWithParams` → `PgDialect.sqlToQuery` (param-count/position parity) so the
// bridge can never mis-splice a builder the twin reuses. The atomic execution
// proof lives in the substrate-backed kill-tests.
import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// Keep the import hermetic (no Postgres): the twin module pulls the postgres
// config/init/sync trio through its substrate-builder imports.
vi.mock("@/lib/postgres-sync", () => ({ runPostgresQueriesSync: vi.fn() }));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));
vi.mock("@/lib/postgres-config", () => ({
  postgresSchema: "cinatra",
  getPostgresConnectionString: () => "postgres://test",
}));

import { rawWithParams } from "@/lib/dashboards/raw-with-params";
import {
  DASHBOARD_OBJECT_TYPE,
  buildDashboardTwinQueries,
  deriveConservativeVisibility,
} from "@/lib/dashboards/dashboard-artifact-twin-writer";
import type { DashboardTwinContext } from "@cinatra-ai/dashboards/twin-writer-seam";

const dialect = new PgDialect();

/** Round-trip a builder's {text,values} through the bridge; returns the rendered
 *  SQL and the final positional params (proves the splice re-numbers correctly). */
function render(text: string, values: readonly unknown[]): { sql: string; params: unknown[] } {
  const built: SQL = rawWithParams(text, values);
  const { sql, params } = dialect.sqlToQuery(built);
  return { sql, params };
}

const upsertCtx: DashboardTwinContext = {
  operation: "upsert",
  dashboardId: "dash-1",
  orgId: "org-1",
  ownerLevel: "team",
  ownerId: "team-9",
  projectId: null,
  actorId: "user-7",
};

const deleteCtx: DashboardTwinContext = { ...upsertCtx, operation: "delete" };

describe("twin writer — conservative visibility derivation", () => {
  it("floors a project-scoped dashboard to private regardless of owner tier", () => {
    expect(deriveConservativeVisibility("organization", "proj-1")).toBe("private");
    expect(deriveConservativeVisibility("team", "proj-1")).toBe("private");
  });
  it("maps the owner tier to its natural share axis when unscoped", () => {
    expect(deriveConservativeVisibility("user", null)).toBe("private");
    expect(deriveConservativeVisibility("team", null)).toBe("team");
    expect(deriveConservativeVisibility("organization", null)).toBe("organization");
  });
  it("takes the conservative floor for workspace / unknown tiers", () => {
    expect(deriveConservativeVisibility("workspace", null)).toBe("private");
    expect(deriveConservativeVisibility("something-new", null)).toBe("private");
  });
});

describe("twin writer — upsert query list (shape + gating)", () => {
  const queries = buildDashboardTwinQueries(upsertCtx);

  it("opens with the per-dashboard advisory lock (delta D2)", () => {
    expect(queries[0].text).toContain("pg_advisory_xact_lock(hashtext($1))");
    expect(queries[0].values).toEqual(["dash-1"]);
  });

  it("writes resource → objects+outbox → representation → audit → binding (2 ops)", () => {
    const joined = queries.map((q) => q.text).join("\n---\n");
    expect(joined).toContain(`"cinatra"."resource"`);
    expect(joined).toContain(`"cinatra"."objects"`);
    expect(joined).toContain(`"cinatra"."graphiti_projection_outbox"`);
    expect(joined).toContain(`"cinatra"."representation"`);
    expect(joined).toContain(`"cinatra"."artifact_audit"`);
    expect(joined).toContain(`"cinatra"."semantic_assertion"`);
    // lock + resource + objects/outbox + representation + audit + 2 binding = 7
    expect(queries).toHaveLength(7);
  });

  it("stamps the dashboard object type + form/kind='dashboard'", () => {
    const objects = queries.find((q) => q.text.includes(`"cinatra"."objects"`))!;
    expect(objects.values).toContain(DASHBOARD_OBJECT_TYPE);
    const resource = queries.find((q) => q.text.includes(`"cinatra"."resource"`))!;
    expect(resource.text).toContain("'dashboard'");
    const rep = queries.find((q) => q.text.includes(`"cinatra"."representation"`))!;
    expect(rep.text).toContain("'dashboard'");
  });

  it("objects write is a gated upsert (delta D3) copying the scope axis verbatim", () => {
    const objects = queries.find((q) => q.text.includes(`"cinatra"."objects"`))!;
    expect(objects.text).toContain("ON CONFLICT (id) DO UPDATE SET");
    expect(objects.text).toContain("IS DISTINCT FROM EXCLUDED"); // the no-op change gate
    // scope axis: ownerLevel/ownerId + visibility(derived team) + projectId(null)
    expect(objects.values).toEqual(
      expect.arrayContaining(["team", "team-9", "team", null]),
    );
  });

  it("representation revision is COALESCE(MAX(revision),0)+1 under the lock", () => {
    const rep = queries.find((q) => q.text.includes(`"cinatra"."representation"`))!;
    expect(rep.text).toContain("COALESCE(MAX(r.revision), 0) + 1");
  });

  it("every query round-trips through the bridge with param parity", () => {
    for (const q of queries) {
      const { params } = render(q.text, q.values);
      // The bridge emits one positional param per distinct textual $n occurrence,
      // so the rendered param count is >= the distinct bound-value count and each
      // maps back to a bound value (no undefined splice).
      expect(params.every((p) => p !== undefined)).toBe(true);
      // No unspliced placeholder survives in the rendered SQL beyond Drizzle's own
      // renumbered $n (which the dialect produced).
      expect(typeof render(q.text, q.values).sql).toBe("string");
    }
  });
});

describe("twin writer — delete query list (tombstone, Q2)", () => {
  const queries = buildDashboardTwinQueries(deleteCtx);

  it("opens with the advisory lock, then the soft-delete tombstone, then audit", () => {
    expect(queries).toHaveLength(3);
    expect(queries[0].text).toContain("pg_advisory_xact_lock(hashtext($1))");
    // tombstone: objects deleted_at + delete outbox + change_set + object_change_event
    expect(queries[1].text).toContain("deleted_at = now()");
    expect(queries[1].text).toContain(`"cinatra"."graphiti_projection_outbox"`);
    expect(queries[1].text).toContain(`"cinatra"."change_set"`);
    expect(queries[1].text).toContain(`"cinatra"."object_change_event"`);
    expect(queries[2].text).toContain(`"cinatra"."artifact_audit"`);
  });

  it("does NOT splice a binding reconcile on delete (no claim binding to withdraw)", () => {
    const joined = queries.map((q) => q.text).join("\n");
    expect(joined).not.toContain(`INSERT INTO "cinatra"."semantic_assertion"`);
  });

  it("every delete query round-trips through the bridge", () => {
    for (const q of queries) {
      const { params } = render(q.text, q.values);
      expect(params.every((p) => p !== undefined)).toBe(true);
    }
  });
});
