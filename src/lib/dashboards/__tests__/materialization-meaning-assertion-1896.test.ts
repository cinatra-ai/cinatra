// Behaviour assertion for cinatra-ai/cinatra#1896 Scope 2 (the linked
// materialization meaning-assertion delta), gated on the first
// dashboardContribution meaning pack `@cinatra-ai/web-analytics-dashboard-artifact`
// (cinatra-ai/web-analytics-dashboard-artifact#1).
//
// QUESTION (from the pack issue's Scope 2): does an installed meaning pack's
// claim land as an eligible `authoring_skill` `semantic_assertion` on the
// materialized dashboard instance? The materializer (`materializeExtensionTemplate`
// / `materializeExtensionInstanceForProject`) pairs the artifact-substrate TWIN
// through the fail-closed twin seam — so the twin write is where such an
// assertion is minted.
//
// This test is DB-FREE (identical posture to `dashboard-artifact-twin-writer.test.ts`):
// it asserts the ORDERED substrate query list the twin emits, and the twin
// CONTEXT shape the materializer passes. It was authored verification-first as a
// RED probe (#2026) pinning the ABSENCE of the assertion; the linked core delta
// then landed and this file was FLIPPED to assert the behaviour (built under
// owner ruling 2026-07-23 (groganz)):
//
//   ANSWER (GREEN): an extension-materialized upsert (`ctx.extensionId` set) now
//   mints an eligible `authoring_skill` (CLASSIC-basis) `semantic_assertion` for
//   the twin artifact (`artifact_id = dashboardId`, `extension` = the pack),
//   spliced into the twin tx VERBATIM from `buildAssertSemanticTypeQueries` (the
//   same builder `assertSemanticType` uses) under the twin's held per-artifact
//   advisory lock. A user/operator/agent dashboard (`extension_id` null) mints
//   NONE — the pre-#1896 twin behaviour, unchanged.
//
// The delta was: (a) thread the materializing pack's `extensionId` through the
// twin seam + `twinCtx` + every `pairTwin` call site (additive), and (b) splice
// the classic `authoring_skill` assertion on the extension-materialized upsert
// path only.
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

const MEANING_PACK = "@cinatra-ai/web-analytics-dashboard-artifact";

/** An extension-materialized dashboard's twin context — exactly what
 *  `materializeExtensionTemplate` builds via `twinCtx(row, "upsert", actorId)`.
 *  A materialized template row carries `extensionId` = the meaning pack, and the
 *  twin CONTEXT now carries that channel (the delta this file asserts). */
const materializedTwinCtx: DashboardTwinContext = {
  operation: "upsert",
  dashboardId: "dash-web-analytics-template",
  orgId: "org-1",
  ownerLevel: "organization",
  ownerId: "org-1",
  projectId: null,
  actorId: "user-7",
  extensionId: MEANING_PACK,
  // The two materialize writers pass the explicit mint intent.
  mintMeaningAssertion: true,
};

/** A plain user/operator dashboard's twin context — no materializing pack. Proves
 *  the gate: `extension_id` null ⇒ NO meaning assertion (pre-#1896 behaviour). */
const userTwinCtx: DashboardTwinContext = {
  operation: "upsert",
  dashboardId: "dash-user-authored",
  orgId: "org-1",
  ownerLevel: "user",
  ownerId: "user-7",
  projectId: null,
  actorId: "user-7",
  extensionId: null,
};

/** A lifecycle bulk upsert (archive/restore/adopt/upgrade) — carries the pack in
 *  `extension_id` but WITHOUT the materialize mint intent. Proves the NARROW gate
 *  (codex round adoption): an extension-owned upsert that is NOT a materialize
 *  must NOT re-mint the assertion (no archive-time re-mint / no adopt double-mint). */
const lifecycleExtensionTwinCtx: DashboardTwinContext = {
  operation: "upsert",
  dashboardId: "dash-web-analytics-template",
  orgId: "org-1",
  ownerLevel: "organization",
  ownerId: "org-1",
  projectId: null,
  actorId: "system:extension-dashboard-lifecycle",
  extensionId: MEANING_PACK,
  mintMeaningAssertion: false,
};

function joinedText(queries: readonly { text: string }[]): string {
  return queries.map((q) => q.text).join("\n---\n");
}
function flatValues(queries: readonly { values: readonly unknown[] }[]): unknown[] {
  return queries.flatMap((q) => [...q.values]);
}

describe("materialization meaning-assertion — landed behaviour (cinatra#1896 Scope 2)", () => {
  const queries = buildDashboardTwinQueries(materializedTwinCtx);

  it("the twin CONTEXT the materializer pairs carries the meaning pack (extensionId threaded)", () => {
    // The materializer knows the pack (row.extensionId) and the twin seam context
    // now carries it — so the twin can target the meaning pack. Runtime witness of
    // the seam contract used by every pairTwin call site.
    expect("extensionId" in materializedTwinCtx).toBe(true);
    expect(materializedTwinCtx.extensionId).toBe(MEANING_PACK);
    expect(Object.keys(materializedTwinCtx).sort()).toEqual(
      ["actorId", "dashboardId", "extensionId", "mintMeaningAssertion", "operation", "orgId", "ownerId", "ownerLevel", "projectId"].sort(),
    );
  });

  it("mints an eligible authoring_skill meaning assertion for the materializing pack", () => {
    const text = joinedText(queries);
    const values = flatValues(queries);
    // A classic authoring_skill assertion is written on the twin path.
    expect(text).toContain("authoring_skill");
    expect(values).toContain("authoring_skill");
    // The meaning pack is named as the asserting extension.
    expect(values).toContain(MEANING_PACK);
    // It targets the twin artifact (dashboardId == artifact_id) …
    expect(values).toContain(materializedTwinCtx.dashboardId);
    // … and is INSERTed into the semantic_assertion table with `eligible`
    // eligibility (non-matcher source ⇒ eligible), not a matcher draft. The
    // CLASSIC insert's column signature (`confidence, asserted_by_principal`)
    // distinguishes it from the binding reconcile's INSERT (which ends in
    // `assertion_basis, binding_claim_id, binding_generation`).
    expect(text).toContain(`"cinatra"."semantic_assertion"`);
    expect(text).toContain("asserted_by, eligibility, confidence, asserted_by_principal");
    expect(values).toContain("eligible");
  });

  it("the classic assertion is precedence-guarded and never displaces a binding row", () => {
    const text = joinedText(queries);
    // The archive step supersedes SAME-extension lower-or-equal-rank ACTIVE rows
    // but EXCLUDES binding-basis rows, and the INSERT is `WHERE NOT EXISTS` a
    // strictly-higher-rank active same-ext row — the `assertSemanticType`
    // precedence contract, so a `user` pin is never overwritten + a re-materialize
    // is a no-op.
    expect(text).toContain("assertion_basis <> 'binding'");
    expect(text).toContain("WHERE NOT EXISTS");
    // The binding-basis reconcile (a no-op for the self-registered non-dedicated
    // generic dashboard type) is STILL spliced — the meaning assertion is additive
    // to it, not a replacement.
    expect(text).toContain(`"cinatra"."semantic_assertion"`);
  });

  it("a plain user/operator dashboard (extension_id null) mints NO meaning assertion", () => {
    const userQueries = buildDashboardTwinQueries(userTwinCtx);
    const text = joinedText(userQueries);
    const values = flatValues(userQueries);
    // The gate holds: no classic authoring_skill assertion for a non-extension
    // row — neither the `authoring_skill` source token nor the classic INSERT's
    // column signature appears. (The binding reconcile's own no-op INSERT — a
    // `'system'`/`'binding'` winner-CTE that yields no row for the generic
    // dashboard type — is still spliced for BOTH ctx, exactly as before #1896.)
    expect(text).not.toContain("authoring_skill");
    expect(values).not.toContain("authoring_skill");
    expect(values).not.toContain(MEANING_PACK);
    expect(text).not.toContain("asserted_by, eligibility, confidence, asserted_by_principal");
  });

  it("a lifecycle extension upsert (extension_id set, no mint intent) mints NO assertion", () => {
    // The narrow gate: archive/restore/adopt/upgrade carry extension_id but never
    // the materialize mint intent, so no `authoring_skill` classic assertion is
    // spliced — preventing an archive-time re-mint / adopt double-mint.
    const lifecycleQueries = buildDashboardTwinQueries(lifecycleExtensionTwinCtx);
    const text = joinedText(lifecycleQueries);
    const values = flatValues(lifecycleQueries);
    expect(values).not.toContain("authoring_skill");
    expect(text).not.toContain("asserted_by, eligibility, confidence, asserted_by_principal");
    // Same query count as a plain non-extension upsert (no meaning ops appended).
    expect(lifecycleQueries.length).toBe(buildDashboardTwinQueries(userTwinCtx).length);
  });

  it("every twin query still round-trips through the bridge with param parity", () => {
    for (const q of [
      ...queries,
      ...buildDashboardTwinQueries(userTwinCtx),
      ...buildDashboardTwinQueries(lifecycleExtensionTwinCtx),
    ]) {
      const built: SQL = rawWithParams(q.text, q.values);
      const { params } = dialect.sqlToQuery(built);
      expect(params.every((p) => p !== undefined)).toBe(true);
    }
  });
});
