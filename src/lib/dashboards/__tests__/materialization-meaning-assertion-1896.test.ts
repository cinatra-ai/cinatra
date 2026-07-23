// Verification-first probe for cinatra-ai/cinatra#1896 Scope 2 (the linked
// materialization meaning-assertion delta), gated on the first
// dashboardContribution meaning pack `@cinatra-ai/web-analytics-dashboard-artifact`
// (cinatra-ai/web-analytics-dashboard-artifact#1).
//
// QUESTION (from the pack issue's Scope 2): does an installed meaning pack's
// claim ALREADY land as an eligible `authoring_skill` `semantic_assertion` on the
// materialized dashboard instance? The materializer (`materializeExtensionTemplate`
// / `materializeExtensionInstanceForProject`) pairs the artifact-substrate TWIN
// through the fail-closed twin seam — so the twin write is where any such
// assertion would be minted.
//
// This probe is DB-FREE (identical posture to `dashboard-artifact-twin-writer.test.ts`):
// it asserts the ORDERED substrate query list the twin emits, and the twin
// CONTEXT shape the materializer can pass. It documents the CURRENT reality (the
// gap) so the answer is unambiguous and the delta target is pinned:
//
//   FINDING (RED for the desired behavior): the twin the materializer pairs
//   mints NO `authoring_skill` meaning assertion. The only `semantic_assertion`
//   touch is `buildBindingReconcileQueries` — a BINDING-basis (`asserted_by`
//   `system`) reconcile that is a NO-OP for the generic, self-registered,
//   non-dedicated `@cinatra-ai/dashboard-artifact:dashboard` twin type. And
//   `DashboardTwinContext` carries NO `extensionId`, so the twin has no channel
//   to name the meaning pack whose claim it would assert.
//
// The linked core delta (a SEPARATE PR) must: (a) thread the materializing
// pack's `extensionId` through the twin seam + `twinCtx`, and (b) splice an
// eligible `authoring_skill` (classic-basis) `semantic_assertion` for the twin
// artifact, `extension` = the pack, on the extension-materialized upsert path.
// When it lands, the `it.todo` below becomes a real assertion and the two
// "no meaning assertion today" guards flip.
//
// NO MIGRATION is implied: the `semantic_assertion` table + the `authoring_skill`
// source already exist (semantic-assertion-schema.ts / semantic-assertion-store.ts).

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
import { buildDashboardTwinQueries } from "@/lib/dashboards/dashboard-artifact-twin-writer";
import type { DashboardTwinContext } from "@cinatra-ai/dashboards/twin-writer-seam";

const dialect = new PgDialect();

/** An extension-materialized dashboard's twin context — exactly what
 *  `materializeExtensionTemplate` builds via `twinCtx(row, "upsert", actorId)`.
 *  A materialized template row carries `extensionId` = the meaning pack; the
 *  twin CONTEXT, however, has no field to receive it (the gap this probe pins). */
const materializedTwinCtx: DashboardTwinContext = {
  operation: "upsert",
  dashboardId: "dash-web-analytics-template",
  orgId: "org-1",
  ownerLevel: "organization",
  ownerId: "org-1",
  projectId: null,
  actorId: "user-7",
};

const MEANING_PACK = "@cinatra-ai/web-analytics-dashboard-artifact";

function joinedText(queries: readonly { text: string }[]): string {
  return queries.map((q) => q.text).join("\n---\n");
}
function flatValues(queries: readonly { values: readonly unknown[] }[]): unknown[] {
  return queries.flatMap((q) => [...q.values]);
}

describe("materialization meaning-assertion — current reality (cinatra#1896 Scope 2 gap)", () => {
  const queries = buildDashboardTwinQueries(materializedTwinCtx);

  it("the twin CONTEXT the materializer pairs carries no channel for the meaning pack (extensionId absent)", () => {
    // The materializer knows the pack (row.extensionId) but the twin seam context
    // drops it — so the twin cannot target a meaning pack. Runtime witness of the
    // seam contract used by every pairTwin call site.
    expect("extensionId" in materializedTwinCtx).toBe(false);
    expect(Object.keys(materializedTwinCtx).sort()).toEqual(
      ["actorId", "dashboardId", "operation", "orgId", "ownerId", "ownerLevel", "projectId"].sort(),
    );
  });

  it("mints NO eligible authoring_skill meaning assertion on the materialized twin", () => {
    const text = joinedText(queries);
    const values = flatValues(queries);
    // No classic authoring_skill assertion is written anywhere on the twin path.
    expect(text).not.toContain("authoring_skill");
    expect(values).not.toContain("authoring_skill");
    // Nor is the meaning pack named as an asserting extension.
    expect(values).not.toContain(MEANING_PACK);
  });

  it("the ONLY semantic_assertion touch is the binding-basis reconcile no-op (system, not authoring_skill)", () => {
    const text = joinedText(queries);
    // The twin splices buildBindingReconcileQueries (assertion_basis 'binding',
    // asserted_by 'system') — a no-op for the self-registered, non-dedicated
    // generic dashboard type. This is NOT the pack's classic meaning assertion.
    expect(text).toContain(`"cinatra"."semantic_assertion"`);
    expect(text).not.toContain("'authoring_skill'");
  });

  it("every twin query still round-trips through the bridge with param parity", () => {
    for (const q of queries) {
      const built: SQL = rawWithParams(q.text, q.values);
      const { params } = dialect.sqlToQuery(built);
      expect(params.every((p) => p !== undefined)).toBe(true);
    }
  });

  // RED TARGET — the linked core delta (separate PR) makes this real: the
  // extension-materialized twin upsert mints an eligible `authoring_skill`
  // (classic) `semantic_assertion` for the twin artifact with `extension` set to
  // the materializing meaning pack. Flipping this on requires threading
  // `extensionId` through DashboardTwinContext + twinCtx first.
  it.todo(
    "materialization mints an eligible authoring_skill semantic_assertion for the meaning pack (pending the linked cinatra#1896 delta)",
  );
});
