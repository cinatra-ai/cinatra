// core__0087 — DROP the demoted `dashboards.visibility` column (ACL cutover
// Phase-3; cinatra#1898, epic #1883 §D7; product decision 2026-07-20 "ruling 5":
// a dashboard is ALWAYS visible to everyone in its scope).
//
// WHAT. One destructive DDL step on a table that holds user data:
//   ALTER TABLE dashboards DROP COLUMN IF EXISTS visibility
// The column's CHECK constraint (`dashboards_visibility_check`, plus the inline
// CHECK a fresh CREATE produced) rides the column drop automatically — a column
// constraint is dropped with its column, so no separate DROP CONSTRAINT is
// needed and none is issued. RESTRICT (the default) is deliberate: if any
// operator-created index/view/generated column depends on the column the ALTER
// FAILS LOUDLY rather than CASCADE-dropping something this migration never
// enumerated.
//
// WHY THIS IS SAFE NOW (the "resolver soak" acceptance clause). Phase-2
// (PR #2064, merged) replaced the dashboard-local ACL internals AND the
// library's dual authorization with ONE canonical resolver: access derives
// purely from scope (owner_level/owner_id + the project_id refinement), the row
// projection of the same canonical `object.read` filter the library compiles.
// Since that flip `resolveDashboardAccess` has not read `visibility`, and
// core__0082 converged every dashboard twin's `objects` tuple onto the canonical
// mapping. The column has been WRITE-ONLY ever since: no read path, no filter,
// no index, no view. Dropping it is therefore a pure shape change — it removes
// dead storage, not an authorization input. The demoted column is the ONLY
// column this phase drops: `owner_level`/`owner_id` are NOT demoted — they are
// the scope axis the canonical mapping reads, and they additionally back the
// per-entity identity composite (#700) and its unique indexes.
//
// DATA. `visibility` values are non-authoritative pre-cutover ACL state. No
// other column, row or table is touched; `dashboards` row identity, config,
// revisions (`dashboard_revisions`, kept per ruling 5) and every scope column
// are untouched. Cube DATA authorization (SecurityContext visibility resolvers)
// is a different subsystem entirely and is not touched here.
//
// IDEMPOTENT / RE-RUNNABLE. `DROP COLUMN IF EXISTS` is a no-op once the column
// is gone. A FRESH install bootstraps the post-drop shape (the `dashboards`
// CREATE in src/lib/drizzle-store.ts carries no `visibility` column, spread in
// the SAME PR) and ledger-fakes the chain; an EXISTING deployment executes this
// module at boot / `cinatra db migrate`. Unqualified names ride the runner's
// search_path (the app schema). Metadata-only DDL — no noTransaction().
//
// POSTCONDITION (fail-loud). After the drop the module asserts the column is
// absent from `information_schema.columns` for the CURRENT schema, so a partial
// or silently-skipped apply RAISEs and rolls the transaction back rather than
// leaving a half-migrated shape behind.
//
// SEQ 0087 — strictly greater than the max seq on live origin/main
// (core__0086_dependency-edge-declared-role) and greater than every seq claimed
// by an open PR (checked at authoring time: no open PR carries a
// migrations/core/ module). Migration seq is assigned at MERGE: a concurrent
// lane may land an intervening seq first, in which case a rename-only renumber
// of this module + its manifest fragment is normal (the runner tolerates
// sequence gaps). migrations/** is HIGH-RISK (owner approval required); the lane
// never merges.
//
// DOWN. Restores the column SHAPE — `visibility text NOT NULL DEFAULT 'private'`
// plus its CHECK — so a rollback to a Phase-2-era image (which WRITES the column
// on every insert but never reads it) keeps working. HONEST COST: the original
// PER-ROW values are NOT recoverable; every row comes back at the `'private'`
// default. That is harmless for Phase-2-era code, which never reads the column.
// A rollback PAST Phase-2, to code that still authorizes on `visibility`, is NOT
// supported by this pair: core__0082 (the twin scope-tuple convergence) is
// itself irreversible, so the ACL cutover as a whole is a one-way door. Restore
// from a backup if the original values are genuinely required.

/** SQL-identifier escaper for an optional schema qualifier (integration path). */
function escId(s) {
  return String(s).replaceAll('"', '""');
}

/**
 * Build the destructive DROP. Idempotent (`IF EXISTS`); RESTRICT by default so a
 * dependent object fails the ALTER loudly instead of being CASCADE-dropped.
 * @param {string} [schema] optional schema qualifier (integration path).
 * @returns {string}
 */
export function buildDropVisibilitySql(schema) {
  const t = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  return `ALTER TABLE ${t("dashboards")} DROP COLUMN IF EXISTS visibility`;
}

/**
 * Build the FAIL-LOUD postcondition: the `dashboards.visibility` column must be
 * ABSENT after the drop. RAISEs (rolling the transaction back) otherwise.
 * @param {string} [schema] optional schema qualifier (integration path);
 *   defaults to the runner's current schema.
 * @returns {string}
 */
export function buildPostconditionSql(schema) {
  const schemaExpr = schema ? `'${escId(schema).replaceAll("'", "''")}'` : "current_schema()";
  return `DO $core0087$
DECLARE
  present bigint;
BEGIN
  SELECT count(*) INTO present
    FROM information_schema.columns
   WHERE table_schema = ${schemaExpr}
     AND table_name   = 'dashboards'
     AND column_name  = 'visibility';
  IF present > 0 THEN
    RAISE EXCEPTION 'core__0087: dashboards.visibility still present after the drop (expected absent) — the demoted ACL column was not removed. Transaction rolled back (no partial apply).';
  END IF;
END
$core0087$`;
}

/**
 * Build the ordered statement list (drop → postcondition). Exposed for the
 * integration test to drive against a real schema.
 * @param {string} [schema]
 * @returns {string[]}
 */
export function buildUpSql(schema) {
  return [buildDropVisibilitySql(schema), buildPostconditionSql(schema)];
}

/**
 * Build the DOWN shape restoration (column + CHECK). Idempotent.
 * @param {string} [schema]
 * @returns {string[]}
 */
export function buildDownSql(schema) {
  const t = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  return [
    `ALTER TABLE ${t("dashboards")} ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private'`,
    `DO $core0087down$ BEGIN
      ALTER TABLE ${t("dashboards")}
        ADD CONSTRAINT dashboards_visibility_check
        CHECK (visibility IN ('private','owners','members'));
    EXCEPTION WHEN duplicate_object THEN NULL; END $core0087down$`,
  ];
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  for (const sql of buildUpSql()) {
    pgm.sql(`${sql};`);
  }
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Shape-only restoration — see the DOWN note in the header for the honest
  // cost (original per-row values are not recoverable; all rows return at the
  // 'private' default, which Phase-2-era code writes but never reads).
  for (const sql of buildDownSql()) {
    pgm.sql(`${sql};`);
  }
}
