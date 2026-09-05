// core__0101 — the LAUNCH ANCHOR (cinatra#2809, per-scope surfaces S3, epic #2806).
//
// The operator-upgrade twin of the two fresh-install bootstrap halves widened
// in the SAME PR:
//
//   * the `agent_runs` column entry        (src/lib/drizzle-store.ts)
//   * `assistantThreadSchemaQueries`       (src/lib/assistant-thread-schema.ts)
//
// Both spread the statements built by `src/lib/launch-scope-anchor.ts`, and the
// parity suite compares those strings against the ones below.
//
// WHAT IT STORES. A run and a thread are now launched FROM a vantage — the
// workspace, an organization, a team, a project, or a person's own scope — and
// the vantage a launch was made from is the instance's HOME. `LaunchScopeAnchorV1`
// is the closed payload: `{ v: 1, kind: "workspace" }`, or `{ v: 1, kind:
// "organization" | "team" | "project" | "user", id }`. The reader is
// `src/lib/launch-scope-anchor.ts` and nothing else parses the column.
//
// WHY A COLUMN OF ITS OWN. Every column that could have answered the question
// moves: `assistant_threads.project_id` is the resource-project-move key, an
// org membership changes, a run's actor can be re-pointed. An address derived
// from a moving column moves with it, so a person's bookmark would quietly open
// somewhere else — or on a scope the launch was never made from. This column is
// written ONCE, from the exact launch route, and never updated.
//
// ADDITIVE AND NULLABLE, WITH NO BACKFILL. A row that predates the column reads
// NULL, which resolves to UNANCHORED and stays on the flat bare route, labelled
// Legacy. There is deliberately no backfill and no inference from another
// column: inventing a home for a launch nobody recorded would be recording a
// launch nobody made. That is also why nothing here is ever set NOT NULL.
//
// IDEMPOTENT: both statements are ADD COLUMN IF NOT EXISTS, so this is a no-op
// on a database the bootstrap already created wide and a widening on every
// deployed one, and it writes to no existing row.
//
// NOT DESTRUCTIVE by the convention's classifier: it adds two nullable columns,
// changes no key, replaces no index, and deletes nothing.
//
// SEQ 0101 — strictly greater than the max shipped seq on the default branch
// (core__0100). A concurrent lane may land the next seq first, in which case a
// rename-only renumber is normal. migrations/** is HIGH-RISK: maintainer
// approval required; the lane never merges.
//
// DOWN. Drops both columns. The honest cost is stated rather than hidden: the
// anchors go with them, and because there is no backfill there is nothing to
// re-derive them from — every instance returns to the flat bare route, which is
// exactly where they were before this migration.

/** Idempotent DDL mirroring the bootstrap leaves — safe to run after them, and
 *  a no-op on any database the bootstrap has already created wide. */
export const launchScopeAnchorDdlSql = `
  ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS launch_scope_anchor jsonb;
  ALTER TABLE assistant_threads ADD COLUMN IF NOT EXISTS launch_scope_anchor jsonb;
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(launchScopeAnchorDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`
    ALTER TABLE assistant_threads DROP COLUMN IF EXISTS launch_scope_anchor;
    ALTER TABLE agent_runs DROP COLUMN IF EXISTS launch_scope_anchor;
  `);
}
