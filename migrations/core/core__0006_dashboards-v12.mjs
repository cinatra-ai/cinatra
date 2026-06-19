// core__0006: one-time migration of legacy dashboard configs to the v1.2
// analytics envelope (cinatra#327, design §4).
//
// BEFORE: two structurally-incompatible dashboard config families shared the
// `dashboards.config_json` jsonb column, discriminated by `config_version`:
//   - legacy operator/agent analytics configs (semver `1.0.0` / `1.1.0`), a
//     bare drizzle-cube `DashboardConfig` rendered by the legacy grid; and
//   - extension v1.2 configs (literal `v1.2` apiVersion), typed-portlet
//     compositions rendered by `PortletHost`.
// #325 added the keystone `analytics` portlet kind (a v1.2 portlet that wraps a
// WHOLE drizzle-cube config at `config.dashboard`); #326 made every NEW
// operator/agent write emit that v1.2 envelope. This migration retires the
// legacy persisted family: it rewrites every EXISTING `1.0.0`/`1.1.0` row AND
// revision into the SAME v1.2 analytics envelope #326's `wrapDcAsV12` produces,
// so `/dashboards/[id]` renders every dashboard through the one `PortletHost`
// path and the legacy parse/dispatch becomes deletable (#329).
//
// AFTER (per row/revision): `config_json` becomes
//   {
//     "apiVersion": "v1.2",
//     "scopeLevel": <derived>,
//     "portlets": [
//       { "instanceId": "analytics", "kind": "analytics", "version": "1.0.0",
//         "slot": "fixed", "config": { "dashboard": <old config_json> } }
//     ]
//   }
// and `config_version` becomes `v1.2`. This is byte-for-byte the envelope
// `packages/dashboards/src/v12-envelope.ts::wrapDcAsV12(<old>, <scope>)` emits
// (the create/save path), so a migrated row is indistinguishable from a
// freshly-saved one and passes the SAME registry validator (`assertConfigV12`
// → `validateDashboardConfigV12` + the analytics kind's `validateConfig`).
//
//   - `scopeLevel` derivation (design §4a): a project-scoped row
//     (`project_id IS NOT NULL` OR `template_scope = 'project'`) maps to
//     `'project'`; otherwise the row's `owner_level`
//     (`user`/`team`/`organization`/`workspace`) maps identity. An
//     owner_level outside the enum degrades to `'user'` (mirrors
//     `ownerLevelToScopeLevel` so a corrupt row can never produce an
//     out-of-enum scopeLevel that fails v1.2 validation).
//   - `dashboard_revisions` carries NO owner/project/template columns (only
//     `dashboard_id, revision_number, config_json, config_version, created_by`).
//     Its scope is therefore derived by JOINing the parent `dashboards` row on
//     `dashboard_id` (design §4a / schema.ts revisions table).
//
// IDEMPOTENT: every statement is predicated on `config_version IN
// ('1.0.0','1.1.0')`. A row already at `v1.2` (an extension dashboard, a
// #326-era operator save, or a re-run of this migration) is excluded, so a
// second `up()` changes zero rows. The column-default flips use the
// existence-guarded `information_schema` probe so they are no-ops once applied.
//
// EXISTING-DB DEFAULT FLIP (design §4a): an upgraded database created its
// `dashboards.config_version` column with `DEFAULT '1.0.0'` baked in. The
// fresh-install default comes from the bootstrap DDL (`drizzle-store.ts`) +
// the Drizzle mirror (`store/schema.ts`), both flipped to `'v1.2'` in this PR;
// this migration owns the EXISTING-DB default by `ALTER COLUMN ... SET DEFAULT
// 'v1.2'`. The two are distinct and BOTH required: the DDL never re-runs the
// SET DEFAULT against an already-created column, so without this ALTER an
// upgraded DB would keep defaulting new inserts to `1.0.0` while fresh installs
// default to `v1.2` — a silent lineage divergence. `dashboard_revisions` has NO
// column default (its `config_version` is always written explicitly), so there
// is nothing to flip there.
//
// REVERSIBLE / SCOPED `down()` (design §4a): `down()` targets ONLY rows THIS
// migration produced — gated on the migrated-wrapper shape
// (`config_json -> 'portlets' -> 0 ->> 'kind' = 'analytics'`) AND
// `extension_id IS NULL` (migrated rows are always operator/agent, never
// extension-owned). A blanket unwrap of every `v1.2` row would corrupt genuine
// extension v1.2 dashboards and any future non-analytics v1.2 dashboard, so the
// guard is load-bearing. It unwraps `portlets[0].config.dashboard` back to the
// column root and restores `config_version = '1.1.0'` (the `1.0.0` vs `1.1.0`
// provenance is intentionally not recoverable — create always stamped `1.1.0`,
// design §4a), and resets the column default to `'1.0.0'`. A pre-existing
// extension/non-analytics `v1.2` row is left untouched.
//
// Set-based, run entirely in Postgres via `jsonb_build_object` (no app
// round-trip). Unqualified names ride the runner's session `search_path`
// (the app schema, SUPABASE_SCHEMA).

/**
 * SQL expression deriving the v1.2 `scopeLevel` for a `dashboards` row alias.
 * Project scope overrides owner level; an out-of-enum owner_level degrades to
 * 'user' (parity with v12-envelope.ts::ownerLevelToScopeLevel).
 * @param {string} d  the dashboards row alias (e.g. "dashboards" or "d")
 */
function scopeLevelExpr(d) {
  return `CASE
    WHEN ${d}.project_id IS NOT NULL OR ${d}.template_scope = 'project' THEN 'project'
    WHEN ${d}.owner_level IN ('user','team','organization','workspace') THEN ${d}.owner_level
    ELSE 'user'
  END`;
}

/**
 * SQL expression building the v1.2 analytics envelope around a bare DC config
 * column, with a parameterized scopeLevel expression. Mirrors
 * v12-envelope.ts::wrapDcAsV12 (apiVersion 'v1.2', single fixed-slot analytics
 * portlet, instanceId/kind 'analytics', version '1.0.0', config.dashboard =
 * the old config). jsonb stores keys normalized, so emit order is irrelevant.
 * @param {string} dcCol      column holding the bare DC config (e.g. "dashboards.config_json")
 * @param {string} scopeExpr  SQL expression yielding the scopeLevel string
 */
function wrapEnvelopeExpr(dcCol, scopeExpr) {
  return `jsonb_build_object(
    'apiVersion', 'v1.2',
    'scopeLevel', (${scopeExpr}),
    'portlets', jsonb_build_array(
      jsonb_build_object(
        'instanceId', 'analytics',
        'kind', 'analytics',
        'version', '1.0.0',
        'slot', 'fixed',
        'config', jsonb_build_object('dashboard', ${dcCol})
      )
    )
  )`;
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  // 1. Rewrite every legacy `dashboards` row to the v1.2 analytics envelope.
  //    Predicated on the legacy version set → idempotent (already-v1.2 rows,
  //    incl. extension dashboards, are excluded).
  pgm.sql(`UPDATE dashboards
    SET config_json = ${wrapEnvelopeExpr("config_json", scopeLevelExpr("dashboards"))},
        config_version = 'v1.2'
    WHERE config_version IN ('1.0.0', '1.1.0');`);

  // 2. Rewrite every legacy `dashboard_revisions` row. Revisions carry no scope
  //    columns, so JOIN the parent `dashboards` row for scopeLevel (design §4a).
  //    An orphan revision (no parent — impossible under the FK, but defensive)
  //    is left as-is by the inner-join semantics.
  pgm.sql(`UPDATE dashboard_revisions r
    SET config_json = ${wrapEnvelopeExpr("r.config_json", scopeLevelExpr("d"))},
        config_version = 'v1.2'
    FROM dashboards d
    WHERE r.dashboard_id = d.id
      AND r.config_version IN ('1.0.0', '1.1.0');`);

  // 3. Flip the EXISTING-DB column default for `dashboards.config_version`
  //    ('1.0.0' -> 'v1.2'). Guarded so it is a no-op when already 'v1.2'
  //    (fresh installs already get 'v1.2' from the bootstrap DDL, where 0006 is
  //    ledger-faked). `dashboard_revisions.config_version` has no default.
  pgm.sql(`DO $$
    DECLARE cur text;
    BEGIN
      SELECT column_default INTO cur
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'dashboards'
         AND column_name = 'config_version';
      IF cur IS NULL OR cur NOT LIKE '%v1.2%' THEN
        ALTER TABLE dashboards ALTER COLUMN config_version SET DEFAULT 'v1.2';
      END IF;
    END $$;`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reverse — but ONLY rows this migration produced: a migrated-wrapper-shaped
  // `analytics` portlet at portlets[0] AND no extension owner. A pre-existing
  // extension/non-analytics v1.2 row is left untouched (design §4a).
  //
  // 1. `dashboard_revisions` first (FK child): unwrap via the PARENT's wrapper
  //    shape + extension guard so a revision is only reverted when its parent
  //    is a migrated operator/agent row. Restore the bare DC config + '1.1.0'.
  pgm.sql(`UPDATE dashboard_revisions r
    SET config_json = (r.config_json -> 'portlets' -> 0 -> 'config' -> 'dashboard'),
        config_version = '1.1.0'
    FROM dashboards d
    WHERE r.dashboard_id = d.id
      AND r.config_version = 'v1.2'
      AND d.extension_id IS NULL
      AND (r.config_json -> 'portlets' -> 0 ->> 'kind') = 'analytics'
      AND (r.config_json -> 'portlets' -> 0 -> 'config' -> 'dashboard') IS NOT NULL;`);

  // 2. `dashboards`: unwrap portlets[0].config.dashboard back to the root,
  //    restore '1.1.0'. Same wrapper-shape + extension guard.
  pgm.sql(`UPDATE dashboards
    SET config_json = (config_json -> 'portlets' -> 0 -> 'config' -> 'dashboard'),
        config_version = '1.1.0'
    WHERE config_version = 'v1.2'
      AND extension_id IS NULL
      AND (config_json -> 'portlets' -> 0 ->> 'kind') = 'analytics'
      AND (config_json -> 'portlets' -> 0 -> 'config' -> 'dashboard') IS NOT NULL;`);

  // 3. Reset the EXISTING-DB column default to the legacy '1.0.0' (guarded).
  pgm.sql(`DO $$
    DECLARE cur text;
    BEGIN
      SELECT column_default INTO cur
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'dashboards'
         AND column_name = 'config_version';
      IF cur IS NULL OR cur NOT LIKE '%1.0.0%' THEN
        ALTER TABLE dashboards ALTER COLUMN config_version SET DEFAULT '1.0.0';
      END IF;
    END $$;`);
}
