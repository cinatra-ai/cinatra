// core__0048 — drop the workflow subsystem from existing databases (epic #1035,
// Slice D; folded into the Slice C producer-stop PR #1617 because the
// schema-migration gate's atomicity requirement makes the destructive DDL and
// the fresh-schema strip one change).
//
// WHY A MIGRATION (the destructive half). Slice C removed the workflow extension
// kind end-to-end on the host: the packages/workflows engine, the host seams,
// the reconciler boot loop, the /workflows app route, and the MCP/object
// workflow surfaces — and STRIPPED the fresh-schema DDL in
// src/lib/drizzle-store.ts (buildCreateStoreSchemaQueries) so a fresh install is
// born WITHOUT any of it. But `CREATE TABLE IF NOT EXISTS` / an already-added
// CHECK are no-ops on an EXISTING deployed database: the 10 workflow tables, the
// two agent_runs workflow-provenance columns + index, and the three workflow-
// widened CHECK constraints all still live on every upgraded deployment. This
// module removes them on the operator upgrade path. On a FRESH schema the
// bootstrap already produces the post-removal shape, so the chain is
// ledger-faked there (see migrations/README.md "How migrations run").
//
// CLEAN BREAK (epic #1035 mandate — drop, not zombie; the owner confirms by
// approving this PR). The workflow host engine is GONE, so nothing reads or
// writes these tables/columns/kinds anymore. This migration deletes them
// outright rather than leaving dead structure behind:
//   1. Clean-break DELETE of workflow-kind rows so the narrowed CHECKs validate.
//      extension_co_owners / extension_access_policy carry a POLYMORPHIC
//      resource_id (no FK — src/lib/drizzle-store.ts), and installed_extension
//      has NO inbound FK, so these are plain, dependency-free deletes.
//   2. Narrow the installed_extension kind CHECK and both extension-grant
//      resource_kind CHECKs to the four surviving kinds (workflow removed) —
//      matching the shape the stripped bootstrap DDL now creates on a fresh
//      install (installed_extension_kind_chk; *_kind_check_v3).
//   3. Drop the agent_runs workflow-provenance columns + their index (the
//      idempotency primitive keeps its generic idempotency_key; provenance is
//      now org_id + template_id). These were nullable text columns with NO FK.
//   4. Drop the 10 workflow tables in reverse FK-dependency order (CASCADE
//      clears the intra-cluster FKs; no non-workflow table references them, so
//      nothing outside the cluster is touched).
//
// IDEMPOTENT / LINEAGE-TOLERANT. Every statement is guarded (`IF EXISTS`,
// `DROP CONSTRAINT IF EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`), and a
// DELETE whose predicate matches nothing is a no-op — so re-running against an
// already-migrated schema, or against the bootstrap-produced fresh shape, does
// nothing. Unqualified names resolve to the app schema the runner sets on
// search_path (what keeps worktree/branch schemas working). Metadata-only DDL
// plus small deletes: runs in the runner's default single transaction (all or
// nothing) — no noTransaction().
//
// DOWN. Irreversible by design. This is a one-shot clean-break removal of an
// entire subsystem whose host engine, tables, and MCP surfaces were deleted in
// the SAME wave (Slice C): the dropped tables' rows and the deleted workflow-
// kind grant/install rows are not retained, and a down() that recreated empty
// workflow tables would restore dead structure no surviving code reads or
// writes. A coherent rollback reverts the whole Slice C/D removal and restores
// from a backup — not this migration alone. down() throws (0033 precedent).

/** The 10 workflow tables, in REVERSE FK-dependency order (drop leaves first). */
const WORKFLOW_TABLES = [
  "workflow_approval",
  "workflow_artifact",
  "workflow_dispatch_lease",
  "workflow_task_attempt",
  "workflow_event",
  "workflow_gate",
  "workflow_dependency",
  "workflow_task",
  "workflow",
  "workflow_template",
];

/** The four surviving installed_extension kinds (workflow removed). */
const KIND_CHECK = `CHECK (kind IN ('agent','connector','artifact','skill'))`;
/** The extension-grant resource_kind domain with 'workflow' removed (mirrors the
 *  post-strip *_kind_check_v3 in buildCreateStoreSchemaQueries). */
const RESOURCE_KIND_CHECK =
  `CHECK (resource_kind IN ('agent_run', 'agent_template', 'skill_package', 'skill', 'connector', 'artifact', 'connection'))`;

/**
 * Add a CHECK constraint only when absent (Postgres has no `ADD CONSTRAINT IF
 * NOT EXISTS` ≤ PG17). Mirrors the bootstrap's DO/EXCEPTION guard so re-running
 * is idempotent. All names/expressions are compile-time constants of this
 * module — nothing interpolates runtime input.
 */
function addCheckIfAbsentSql(table, constraint, checkExpr) {
  return `DO $$ BEGIN
  ALTER TABLE ${table} ADD CONSTRAINT ${constraint} ${checkExpr};
EXCEPTION WHEN duplicate_object THEN NULL; END $$;`;
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  // 1. Clean-break: remove workflow-kind rows so the narrowed CHECKs validate
  //    against existing data (no FK on these polymorphic/inbound surfaces).
  pgm.sql(`DELETE FROM extension_co_owners WHERE resource_kind = 'workflow';`);
  pgm.sql(`DELETE FROM extension_access_policy WHERE resource_kind = 'workflow';`);
  pgm.sql(`DELETE FROM installed_extension WHERE kind = 'workflow';`);

  // 2. Narrow the kind / resource_kind CHECKs to the four surviving kinds.
  pgm.sql(`ALTER TABLE installed_extension DROP CONSTRAINT IF EXISTS installed_extension_kind_chk;`);
  pgm.sql(addCheckIfAbsentSql("installed_extension", "installed_extension_kind_chk", KIND_CHECK));

  pgm.sql(`ALTER TABLE extension_co_owners DROP CONSTRAINT IF EXISTS extension_co_owners_kind_check_v3;`);
  pgm.sql(addCheckIfAbsentSql("extension_co_owners", "extension_co_owners_kind_check_v3", RESOURCE_KIND_CHECK));

  pgm.sql(`ALTER TABLE extension_access_policy DROP CONSTRAINT IF EXISTS extension_access_policy_kind_check_v3;`);
  pgm.sql(addCheckIfAbsentSql("extension_access_policy", "extension_access_policy_kind_check_v3", RESOURCE_KIND_CHECK));

  // 3. Drop the agent_runs workflow-provenance columns + index. The index drops
  //    with its column, but drop it explicitly first for clarity/robustness.
  pgm.sql(`DROP INDEX IF EXISTS agent_runs_workflow_id_idx;`);
  pgm.sql(`ALTER TABLE agent_runs DROP COLUMN IF EXISTS workflow_id;`);
  pgm.sql(`ALTER TABLE agent_runs DROP COLUMN IF EXISTS workflow_task_id;`);

  // 4. Drop the 10 workflow tables (reverse FK order; CASCADE clears the
  //    intra-cluster FK constraints — no external table references them).
  for (const table of WORKFLOW_TABLES) {
    pgm.sql(`DROP TABLE IF EXISTS ${table} CASCADE;`);
  }
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down() {
  throw new Error(
    "core__0048 is a one-shot clean-break removal of the workflow subsystem " +
      "(epic #1035, Slices C/D): the host engine, tables, and MCP surfaces were " +
      "deleted in the same wave, the dropped tables' rows and workflow-kind " +
      "grant/install rows are not retained, and recreating empty workflow tables " +
      "would restore dead structure no surviving code uses. Roll back by " +
      "reverting the Slice C/D change and restoring from a backup, not this " +
      "migration alone.",
  );
}
