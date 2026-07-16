// core__0051: dashboardContribution lineage backfill + durable-absence orphan
// sweep (cinatra-ai/cinatra#1628, S11a — the recovery floor).
//
// SEQ NOTE: the seq is assigned at MERGE and must be strictly greater than the
// max shipped core__ seq at that time (0049 at authoring; #1674 holds 0050).
// Renumber to the next free seq if 0051 is taken before this merges.
//
// BACKGROUND. Extension-shipped dashboards used to ride the `kind:"workflow"`
// install path, which materialized a per-(extension,org) TEMPLATE row + per-
// project INSTANCE rows keyed on `extension_id`. W5 (#1035, core__0048) removed
// the workflow kind — DELETE-ing the workflow `installed_extension` rows + the
// workflow tables — but did NOT touch the `dashboards` table (no FK), and the
// uninstall path no longer archives extension dashboards (the archival step was
// dropped). So any deployment where an operator explicitly installed a workflow
// demo (only `@cinatra-ai/blog-content-workflow` ships `cinatra/dashboard.json`)
// pre-W5 can hold LIVE dashboard rows backed by NO installed extension — rendered
// + bookmark-reachable, labelled with the dead package name (cinatra#1628).
//
// S11a re-homes the carrier onto a versioned `cinatra.dashboardContribution`
// claim with a carrier-INDEPENDENT lineage `contribution_id`, and closes the leak
// with an all-reader liveness/status gate (the fail-safe) + this migration (the
// data-hygiene companion). The three new columns (contribution_id,
// applied_contribution_version, applied_default_json/_hash, archive_reason) and
// the two-tier partial UNIQUE indexes are ADDITIVE and land in the bootstrap DDL
// (buildCreateStoreSchemaQueries in src/lib/drizzle-store.ts); this migration owns
// the two TRANSFORMATIONAL steps below.
//
// UP — two idempotent data steps, in order:
//   (1) LEGACY→LINEAGE BACKFILL. Every extension-owned row (extension_id NOT NULL)
//       missing a contribution_id gets a deterministic, carrier-independent
//       lineage id `legacy:<extension_id>`. A TEMPLATE and its per-project
//       INSTANCES share the extension_id, so they receive the SAME
//       contribution_id — honoring "template + its 0..N instances share one
//       contribution_id". Idempotent (the `contribution_id IS NULL` guard makes a
//       re-run touch zero rows) and index-safe: the derived value is 1:1 with the
//       already-unique (extension_id, org[, project]) shape, so it can never
//       violate the new partial UNIQUE indexes.
//   (2) DURABLE-ABSENCE ORPHAN SWEEP. Archive every non-archived extension-owned
//       row whose extension is DURABLY absent — no `installed_extension` row at
//       all (NOT a merely `archived`/disabled-but-present install, which is
//       recoverable and left alone). This is the data-hygiene companion to the
//       reader gate; it is safe precisely because the reader gate ALSO denies
//       archived + non-live rows at read time. `archive_reason` records the
//       provenance so an adopt-in-place restore (S11b) can find + un-archive them.
//       On the prod fleet this swept ZERO rows at authoring (verified via
//       read-only fleet SQL) — defensive-only, but it closes the latent hazard
//       for any deployment that DID hold orphaned rows.
//
// DOWN. NO-OP (parity with core__0049). (1) A backfilled `contribution_id` is
// indistinguishable from one a later reconcile sets, so nulling it back would
// corrupt live lineage. (2) Un-archiving swept rows would resurrect the exact
// orphan-render leak this migration + the reader gate close. The ledger row still
// records the run.
//
// Plain ESM on purpose (imported by the CLI runner, by src/lib via the Next
// bundle, and by vitest). Unqualified names ride the runner's session
// search_path (SUPABASE_SCHEMA); the exported builders accept an explicit schema
// so the integration test can run the SAME SQL against a throwaway schema.

/** The single producer whose orphaned rows S11a recovers (for test fixtures +
 *  documentation). The sweep is GENERIC (any durably-absent extension); this is
 *  the only package that ever shipped `cinatra/dashboard.json`. */
export const RETIRED_WORKFLOW_CONTRIBUTION_PACKAGE = "@cinatra-ai/blog-content-workflow";

function qi(schema, table) {
  return schema ? `"${schema.replaceAll('"', '""')}"."${table}"` : table;
}

/**
 * Build the legacy→lineage backfill UPDATE. Unqualified (search_path-driven)
 * when `schema` is omitted (production runner); qualified when given (test).
 * @param {string} [schema]
 * @returns {string}
 */
export function buildLineageBackfillSql(schema) {
  const tbl = qi(schema, "dashboards");
  return `UPDATE ${tbl}
     SET contribution_id = 'legacy:' || extension_id
   WHERE extension_id IS NOT NULL
     AND contribution_id IS NULL`;
}

/**
 * Build the durable-absence orphan sweep UPDATE. Archives extension-owned rows
 * with NO installed_extension row for their package (durable absence). Leaves an
 * `archived`-but-present install alone (recoverable). Idempotent (skips already-
 * archived rows).
 * @param {string} [schema]
 * @returns {string}
 */
export function buildOrphanSweepSql(schema) {
  const tbl = qi(schema, "dashboards");
  const inst = qi(schema, "installed_extension");
  return `UPDATE ${tbl} d
     SET status = 'archived',
         archived_at = now(),
         archive_reason = 'orphaned_contribution_sweep',
         updated_at = now()
   WHERE d.extension_id IS NOT NULL
     AND d.status <> 'archived'
     AND NOT EXISTS (
       SELECT 1 FROM ${inst} ie WHERE ie.package_name = d.extension_id
     )`;
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  // Order matters only for clarity — the two steps touch disjoint columns and
  // are each idempotent, so re-running the chain is a no-op.
  pgm.sql(buildLineageBackfillSql());
  pgm.sql(buildOrphanSweepSql());
}

// node-pg-migrate calls `down(pgm)`; this migration's revert is intentionally a
// no-op (see the DOWN note), so it takes no parameter (extra args are ignored).
export function down() {
  // No-op: see the DOWN note in the header. The ledger row records the run.
}
