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
//         "slot": "fixed", "config": { "dashboard": <1.1-shaped config> } }
//     ]
//   }
// and `config_version` becomes `v1.2`. This is byte-for-byte the envelope
// `packages/dashboards/src/v12-envelope.ts::wrapDcAsV12(<dc>, <scope>)` emits
// (the create/save path), so a migrated row is indistinguishable from a
// freshly-saved one and passes the SAME registry validator (`assertConfigV12`
// → `validateDashboardConfigV12` + the analytics kind's `validateConfig`).
//
//   - **`config.dashboard` is always the v1.1 (drizzle-cube grid) DC shape.**
//     The analytics kind's install-time `validateConfig` deep-validates
//     `config.dashboard` against the STRICT `DashboardConfigV1_1Schema`
//     (`packages/dashboards/src/portlets/kinds.ts`
//     ::`validateAnalyticsPortletConfig`), which requires every portlet to carry
//     `title` + `w/h/x/y` + a content spec (`analysisConfig`|`query`). A
//     genuine `1.1.0` row already has that shape, so it is embedded verbatim.
//     But a genuine `1.0.0` row is the PERMISSIVE, type-discriminated shape
//     (`{portlets:[{id,type,title?,cubeId?,query?}]}` — no `w/h/x/y`, see
//     `store/dashboard-config.ts::DashboardConfigV1Schema` and the pure-1.0
//     fixture `render-kind.test.ts` `LEGACY_V1_0_CONFIG`). Embedding a `1.0.0`
//     body verbatim would produce a v1.2 envelope that FAILS that deep validator
//     (`portlets.0.title/w/h/x/y: expected …, received undefined`) — i.e. an
//     invalid-at-rest row the renderer would reject. `1.0.0` rows ARE reachable
//     in prod: the MCP create/update schema accepts an arbitrary `configVersion`
//     and the mutation service's Rule 4 passes a `1.0.0` write through the
//     permissive `parseDashboardConfig` check. So this migration UP-CONVERTS a
//     `1.0.0` body to the v1.1 portlet shape BEFORE wrapping (see
//     `upconvertV1_0ToV1_1Expr`): for each portlet it ADDS the v1.1-required
//     layout fields (`title := COALESCE(NULLIF(title,''), id)`, `w/h/x/y := 0`,
//     `query := COALESCE(query, '{}')` so the `analysisConfig|query` superRefine
//     is satisfied) while PRESERVING every original key (`type`, `cubeId`, a
//     non-empty existing `title`/`query`, top-level `layout`) via `jsonb`
//     concat. `NULLIF(title,'')` is load-bearing: the `1.0.0` schema permits
//     `title: ""` (optional `z.string()`, no `.min(1)`) but the strict v1.1
//     schema requires `title.min(1)`, so an empty title falls back to the
//     always-non-empty `id` [codex merge-safe review]. The
//     synthetic-zero grid coordinates match the drizzle-cube grid's own
//     missing-layout fallback (`render-kind.ts` note: a 1.0 row "renders
//     DEGRADED … the grid tolerates missing layout"), so nothing renders WORSE
//     than it did pre-migration — it now renders through `PortletHost` with a
//     valid embedded DC instead of being rejected. This mirrors, in set-based
//     SQL, the 1.0→1.1 normalization the read path assumes. NOTE: the original
//     design §4a embedded `<old config_json>` verbatim and did NOT call out this
//     1.0→1.1 step — that was a spec gap (a 1.0 row would have migrated to an
//     invalid v1.2 envelope); this migration closes it.
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
// extension-owned) AND **exactly ONE portlet**
// (`jsonb_array_length(config_json -> 'portlets') = 1`). The single-portlet
// clause is load-bearing: this migration ONLY ever produces a single-analytics-
// portlet envelope, but a NON-migrated operator/agent v1.2 row can legitimately
// be analytics-first WITH sibling portlets — `#326`'s `reEnvelopeDcSave`
// preserves existing siblings when it re-wraps a save. The kind+extension guard
// alone would match such a multi-portlet row and unwrap it to ONLY
// `portlets[0].config.dashboard`, DROPPING its siblings. Requiring a single
// portlet excludes every such row, so a multi-portlet operator v1.2 row is left
// untouched (a blanket unwrap of every `v1.2` row would likewise corrupt genuine
// extension v1.2 dashboards). It unwraps `portlets[0].config.dashboard` back to
// the column root and restores `config_version = '1.1.0'`. The `1.0.0` vs
// `1.1.0` provenance is intentionally NOT recoverable: a migrated `1.0.0` row's
// embedded `config.dashboard` is the UP-CONVERTED v1.1 body (see above), so
// `down()` correctly restores it to a valid `1.1.0` row, not the original
// invalid-as-v1.2 `1.0.0` shape — the 1.0→1.1 up-convert is a lossless upgrade
// (a strict superset of the layout fields), so restoring to `1.1.0` never yields
// a WORSE shape (create always stamped `1.1.0` anyway, design §4a). `down()`
// also resets the column default to `'1.0.0'`. A pre-existing
// extension/non-analytics/multi-portlet `v1.2` row is left untouched.
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

/**
 * SQL expression up-converting a bare `1.0.0` DC config to the `1.1.0` (grid)
 * shape the analytics kind's deep validator (`DashboardConfigV1_1Schema`)
 * requires, BEFORE it is embedded at `config.dashboard`. See the header doc:
 * a `1.0.0` portlet (`{id,type,title?,cubeId?,query?}`) lacks the v1.1-required
 * `title` + `w/h/x/y` + content spec, so wrapping it verbatim would yield an
 * invalid-at-rest v1.2 envelope. For EACH portlet this ADDS the missing fields
 * (`title := COALESCE(NULLIF(title,''), id)`; `w/h/x/y := 0`;
 * `query := COALESCE(query,{})` so the `analysisConfig|query` superRefine
 * passes) while PRESERVING every original key — `elem || {added}` keeps
 * `type`/`cubeId`/a NON-EMPTY existing `title`/`query` because the added object
 * only fills gaps via COALESCE. The `NULLIF(title,'')` is load-bearing: the
 * permissive `1.0.0` schema allows `title: ""` (optional `z.string()`, NO
 * `.min(1)`), but the strict v1.1 schema requires `title.min(1)`, so a bare
 * `COALESCE` (which only replaces SQL NULL, not the empty string) would leave a
 * `""` title that FAILS the analytics deep validator — `NULLIF` coerces `''` to
 * NULL so the fallback to the (always non-empty, `id.min(1)`) `id` fires
 * [codex merge-safe review]. The top-level config (including a `1.0.0` `layout`)
 * is preserved via `jsonb_set`, which only replaces `{portlets}`. A
 * non-array/absent `portlets` degrades to `[]` (the source row would already be
 * a malformed DC). `1.1.0` rows do NOT pass through this — they are wrapped
 * verbatim (they already satisfy v1.1).
 * @param {string} dcCol  column holding the bare 1.0 DC config (e.g. "config_json")
 */
function upconvertV1_0ToV1_1Expr(dcCol) {
  return `jsonb_set(
    ${dcCol},
    '{portlets}',
    COALESCE((
      SELECT jsonb_agg(
        elem || jsonb_build_object(
          'title', COALESCE(NULLIF(elem->>'title', ''), elem->>'id'),
          'w', 0, 'h', 0, 'x', 0, 'y', 0,
          'query', COALESCE(elem->'query', '{}'::jsonb)
        )
      )
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(${dcCol} -> 'portlets') = 'array'
             THEN ${dcCol} -> 'portlets' ELSE '[]'::jsonb END
      ) AS elem
    ), '[]'::jsonb)
  )`;
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  // 1a. Rewrite every legacy `1.1.0` `dashboards` row to the v1.2 envelope —
  //     the body is already the v1.1 grid shape the analytics deep validator
  //     accepts, so it is embedded verbatim. Predicated on the version, so
  //     re-running is a no-op (already-v1.2 rows, incl. extension dashboards,
  //     are excluded).
  pgm.sql(`UPDATE dashboards
    SET config_json = ${wrapEnvelopeExpr("config_json", scopeLevelExpr("dashboards"))},
        config_version = 'v1.2'
    WHERE config_version = '1.1.0';`);

  // 1b. Rewrite every legacy `1.0.0` `dashboards` row — UP-CONVERT the bare DC
  //     body to the v1.1 grid shape FIRST (header doc), THEN wrap. Without the
  //     up-convert a 1.0 body produces a v1.2 envelope that fails the analytics
  //     deep validator (`config.dashboard` portlets missing title/w/h/x/y).
  pgm.sql(`UPDATE dashboards
    SET config_json = ${wrapEnvelopeExpr(upconvertV1_0ToV1_1Expr("config_json"), scopeLevelExpr("dashboards"))},
        config_version = 'v1.2'
    WHERE config_version = '1.0.0';`);

  // 2a. Rewrite every legacy `1.1.0` `dashboard_revisions` row. Revisions carry
  //     no scope columns, so JOIN the parent `dashboards` row for scopeLevel
  //     (design §4a). An orphan revision (no parent — impossible under the FK,
  //     but defensive) is left as-is by the inner-join semantics.
  pgm.sql(`UPDATE dashboard_revisions r
    SET config_json = ${wrapEnvelopeExpr("r.config_json", scopeLevelExpr("d"))},
        config_version = 'v1.2'
    FROM dashboards d
    WHERE r.dashboard_id = d.id
      AND r.config_version = '1.1.0';`);

  // 2b. Rewrite every legacy `1.0.0` `dashboard_revisions` row — up-convert the
  //     bare DC body to v1.1 FIRST, THEN wrap (same JOIN-for-scope semantics).
  pgm.sql(`UPDATE dashboard_revisions r
    SET config_json = ${wrapEnvelopeExpr(upconvertV1_0ToV1_1Expr("r.config_json"), scopeLevelExpr("d"))},
        config_version = 'v1.2'
    FROM dashboards d
    WHERE r.dashboard_id = d.id
      AND r.config_version = '1.0.0';`);

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
  //    is a migrated operator/agent row. The single-portlet clause excludes a
  //    multi-portlet operator v1.2 revision (siblings must be preserved).
  //    Restore the bare DC config + '1.1.0'.
  pgm.sql(`UPDATE dashboard_revisions r
    SET config_json = (r.config_json -> 'portlets' -> 0 -> 'config' -> 'dashboard'),
        config_version = '1.1.0'
    FROM dashboards d
    WHERE r.dashboard_id = d.id
      AND r.config_version = 'v1.2'
      AND d.extension_id IS NULL
      AND jsonb_typeof(r.config_json -> 'portlets') = 'array'
      AND jsonb_array_length(r.config_json -> 'portlets') = 1
      AND (r.config_json -> 'portlets' -> 0 ->> 'kind') = 'analytics'
      AND (r.config_json -> 'portlets' -> 0 -> 'config' -> 'dashboard') IS NOT NULL;`);

  // 2. `dashboards`: unwrap portlets[0].config.dashboard back to the root,
  //    restore '1.1.0'. Same wrapper-shape + extension guard, AND exactly one
  //    portlet — a NON-migrated analytics-first operator v1.2 row with sibling
  //    portlets (producible via #326 reEnvelopeDcSave) is left UNTOUCHED so its
  //    siblings are not dropped (this migration only ever produced a single-
  //    analytics-portlet envelope).
  pgm.sql(`UPDATE dashboards
    SET config_json = (config_json -> 'portlets' -> 0 -> 'config' -> 'dashboard'),
        config_version = '1.1.0'
    WHERE config_version = 'v1.2'
      AND extension_id IS NULL
      AND jsonb_typeof(config_json -> 'portlets') = 'array'
      AND jsonb_array_length(config_json -> 'portlets') = 1
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
