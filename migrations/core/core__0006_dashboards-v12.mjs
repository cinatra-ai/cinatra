// core__0006: one-time migration of legacy dashboard configs to the v1.2
// analytics envelope (cinatra#327, design §4; owner decision eng#206).
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
// revision into the SAME single-analytics-portlet v1.2 analytics envelope, so
// `/dashboards/[id]` renders every dashboard through the one `PortletHost` path
// and the legacy parse/dispatch becomes deletable (#329).
//
// OWNER DECISION (eng#206): NO backward compatibility. This is a ONE-SHOT,
// LOSSY-BY-DESIGN canonicalization. The strict v1.2 + analytics validator STAYS
// strict; #329 deletes the legacy parse path. So this migration must
// CANONICALIZE invalid-at-rest legacy data into a registry-VALID v1.2 envelope —
// it cannot rely on, or preserve, a legacy parser. Non-conforming fields are
// dropped/repaired (accepted). The transform is TOTAL: it NEVER throws and ALWAYS
// produces a config that passes the SAME registry validation the app runs at the
// write site (`mutation-service.ts::assertConfigV12` = structural
// `validateDashboardConfigV12` + the analytics kind's deep `config.dashboard`
// check against the strict `DashboardConfigV1_1Schema`).
//
// IMPLEMENTATION (codex-converged, replaces the prior field-by-field SQL
// coercion): a JS-side TOTAL normalizer bundled into THIS module, run INSIDE the
// migration transaction via parameterized `UPDATE ... SET config_json=$1::jsonb`.
// Core migrations are PLAIN RUNTIME ARTIFACTS — they cannot import the TS
// package internals — so the coercer + the minimal final validator + the
// analytics descriptor are BUNDLED here, and a unit test
// (`migration-v12-bundled-normalizer.test.ts`) asserts the bundle is EQUIVALENT
// to the real package validators / `DashboardConfigV1_1Schema` so they cannot
// drift. The legacy SQL field-coercion (and a 1.0->1.1 SQL up-convert) handled
// only well-formed bodies; this normalizer ALSO repairs corrupt-at-rest shapes
// (scalar/null/array root, `dashboardFilterMapping:"bad"`, `eagerLoad:"yes"`,
// `grid:{cols:-1}`, `layoutMode:"freeform"`, `colorPalette:42`, bad portlet
// elements, duplicate/missing ids, ...) — the fallback path ALSO yields a
// validator-valid envelope.
//
// AFTER (per row/revision): `config_json` becomes
//   {
//     "apiVersion": "v1.2",
//     "scopeLevel": <derived>,
//     "portlets": [
//       { "instanceId": "analytics", "kind": "analytics", "version": "1.0.0",
//         "slot": "fixed",
//         "config": {
//           "dashboard": <normalized strict-v1.1 DC>,
//           "__cinatraMigration": "core__0006"   // migration marker (see below)
//         } }
//     ]
//   }
// and `config_version` becomes `v1.2`. The non-marker structure is byte-for-byte
// the envelope `v12-envelope.ts::wrapDcAsV12` emits, so a migrated row is
// indistinguishable in render from a freshly-saved one and passes the SAME
// registry validator (`assertConfigV12`).
//
//   - **MIGRATION MARKER (`portlets[0].config.__cinatraMigration`).** `down()`
//     must revert ONLY rows THIS migration produced. A shape-only guard (single
//     analytics portlet + `extension_id IS NULL`) is UNSAFE: a NATIVE #326
//     operator dashboard (`wrapDcAsV12`) is ALSO a single-analytics-portlet
//     operator envelope, so a shape-only `down()` would FALSELY revert a
//     genuine native-v1.2 dashboard created after this migration. So we stamp a
//     positive marker and `down()` keys on it. The v1.2 root and portlet schemas
//     are `.strict()` (no extra keys allowed there), but `portletConfigV12Schema`
//     types `config` as `z.record(z.string(), z.unknown())` — an OPAQUE record —
//     so `config.__cinatraMigration` is a strict-ALLOWED slot [codex BLOCKER].
//     Placing the marker in `config` (NOT inside `config.dashboard`) keeps the
//     embedded DC byte-equivalent and survives a later `reEnvelopeDcSave`, which
//     replaces only `config.dashboard` and PRESERVES the other `config` keys
//     (`v12-envelope.ts::reEnvelopeDcSave`).
//
//   - **TOTAL normalization (`normalizeDashboardConfig`).** A `1.1.0` body is
//     already the grid shape; a `1.0.0` body lacks the v1.1-required
//     `title`+`w/h/x/y`+content-spec; and a corrupt-at-rest body may be a scalar,
//     null, an array, or carry typed-wrong fields. The normalizer collapses ALL
//     of these to a config that passes the strict `DashboardConfigV1_1Schema`:
//     a non-object root degrades to a MINIMAL VALID EMPTY dashboard; every
//     constrained field has a catch/default at its own boundary; normalized
//     fields WIN over passthrough spread order; unknown keys are KEPT (the live
//     schema is `.passthrough()`, so keeping them is what round-trips a
//     conforming 1.1 body byte-equivalent — strip would DIVERGE from the
//     validator). A conforming 1.1 input is unchanged by normalization (a fixed
//     point), so up()->down() is identity for it.
//
//   - **FINAL VALIDATION (mandatory).** After wrapping, the bundled
//     `validateMigratedEnvelopeV12` runs the SAME checks `assertConfigV12` does
//     (structural + analytics deep). If it EVER fails, that is a migration bug:
//     the migration THROWS, aborting the whole transaction. The "total" guarantee
//     means the fallback path ALSO passes this gate, so it never fires in
//     practice — but it is the hard safety net.
//
//   - `scopeLevel` derivation (design §4a): a project-scoped row
//     (`project_id IS NOT NULL` OR `template_scope = 'project'`) maps to
//     `'project'`; otherwise the row's `owner_level`
//     (`user`/`team`/`organization`/`workspace`) maps identity. An owner_level
//     outside the enum degrades to `'user'` (parity with
//     `v12-envelope.ts::ownerLevelToScopeLevel`), so a corrupt row can never
//     produce an out-of-enum scopeLevel that fails v1.2 validation.
//   - `dashboard_revisions` carries NO owner/project/template columns (only
//     `dashboard_id, revision_number, config_json, config_version, created_by`).
//     Its scope is derived by JOINing the parent `dashboards` row on
//     `dashboard_id` (design §4a / schema.ts revisions table).
//
// CONCURRENCY (codex BLOCKER): the runner's `cinatra-schema-init` advisory lock
// serializes SCHEMA work, NOT app dashboard writes. A `SELECT -> normalize ->
// UPDATE` could miss/clobber a row an app process writes mid-migration. So up()
// (and down()) take `LOCK TABLE dashboards, dashboard_revisions IN SHARE ROW
// EXCLUSIVE MODE` (blocks concurrent writes + DDL, allows reads) BEFORE the
// selects, and up() asserts a ZERO-LEGACY postcondition
// (`COUNT(*) WHERE config_version IN ('1.0.0','1.1.0') = 0` on both tables)
// before returning. This is a coordinated, non-rolling boundary (parity with
// core__0005): apply with pre-#329 writers drained.
//
// IDEMPOTENT: every read is predicated on `config_version IN ('1.0.0','1.1.0')`
// and every UPDATE re-checks that predicate in its WHERE. A row already at `v1.2`
// (an extension dashboard, a #326-era operator save, or a re-run of this
// migration) is excluded, so a second up() changes zero rows. Re-running the
// normalizer on an already-migrated body would be a no-op anyway (it is a fixed
// point), but we never even read those rows. The column-default flip uses the
// existence-guarded `information_schema` probe so it is a no-op once applied.
//
// EXISTING-DB DEFAULT FLIP (design §4a): an upgraded database created its
// `dashboards.config_version` column with `DEFAULT '1.0.0'` baked in. The
// fresh-install default comes from the bootstrap DDL (`drizzle-store.ts`) + the
// Drizzle mirror (`store/schema.ts`), both flipped to `'v1.2'` in this PR; this
// migration owns the EXISTING-DB default by `ALTER COLUMN ... SET DEFAULT 'v1.2'`.
// Both are required and NOT redundant (the DDL never re-runs SET DEFAULT against
// an already-created column). `dashboard_revisions` has NO column default.
//
// REVERSIBLE / SCOPED `down()` (design §4a): `down()` targets ONLY marker-bearing
// rows (`config.__cinatraMigration = 'core__0006'`) AND `extension_id IS NULL`
// AND exactly ONE portlet AND `portlets[0].kind = 'analytics'`. It unwraps
// `portlets[0].config.dashboard` back to the column root (the marker is dropped
// with the rest of the envelope) and restores `config_version = '1.1.0'`. The
// `1.0.0` vs `1.1.0` provenance is intentionally NOT recoverable: a normalized
// body is a valid v1.1 grid config, so `down()` restores it to a valid `1.1.0`
// row (create always stamped `1.1.0` anyway, design §4a) — never a WORSE shape.
// A NATIVE #326 single-analytics operator v1.2 row (no marker), a multi-portlet
// operator v1.2 row, and an extension v1.2 row are all left untouched. `down()`
// also resets the column default to `'1.0.0'`.
//
// Plain ESM on purpose: imported by the CLI runner, by src/lib (Next bundles
// it), and by vitest. Unqualified names ride the runner's session `search_path`
// (the app schema, SUPABASE_SCHEMA).

// ──────────────────────────────────────────────────────────────────────────
// Bundled constants (mirror the package; pinned EQUIVALENT by the unit test).
// ──────────────────────────────────────────────────────────────────────────

/** apiVersion literal — `DASHBOARD_CONFIG_V12_VERSION`. */
export const V12_API_VERSION = "v1.2";
/** Valid v1.2 scopeLevels — `DASHBOARD_SCOPE_LEVELS`. */
export const V12_SCOPE_LEVELS = ["user", "team", "organization", "workspace", "project"];
/** Analytics portlet identity — `ANALYTICS_PORTLET_KIND` / `_VERSION` (+ alias). */
export const ANALYTICS_KIND = "analytics";
export const ANALYTICS_KIND_ALIAS = "cube-dashboard";
export const ANALYTICS_PORTLET_VERSION = "1.0.0";
export const ANALYTICS_INSTANCE_ID = "analytics";
/** Marker value `down()` keys on (stamped at `portlets[0].config.__cinatraMigration`). */
export const MIGRATION_MARKER_KEY = "__cinatraMigration";
export const MIGRATION_MARKER_VALUE = "core__0006";
/** Default grid for the minimal-valid-empty dashboard (positive ints; valid). */
const DEFAULT_GRID = Object.freeze({ cols: 12, rowHeight: 50, minW: 3, minH: 4 });

// ──────────────────────────────────────────────────────────────────────────
// Small total predicates (no throw on any input).
// ──────────────────────────────────────────────────────────────────────────

/** A plain (non-array, non-null) object. Arrays are NOT records [codex SHOULD-FIX]. */
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** Non-empty string. */
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
// NOTE: `Number.isSafeInteger`, NOT `Number.isInteger` [codex MERGE-SAFE BLOCKER].
// The real schema uses Zod v4 `z.number().int()`, which REJECTS values above
// Number.MAX_SAFE_INTEGER (e.g. 1e21, 2**53) even though `Number.isInteger`
// accepts them. Using `Number.isInteger` here would let a `w: 1e21` /
// `grid.cols: 1e21` survive normalization, pass the bundled validator
// (FALSE-valid), get written as v1.2, then FAIL the real DashboardConfigV1_1Schema
// at the app boundary. `Number.isSafeInteger` matches Zod's `.int()` exactly
// (verified empirically against zod@4: MAX_SAFE_INTEGER ok, +1 rejected).

/** A nonnegative SAFE integer (the strict v1.1 w/h/x/y contract; Zod v4 .int()). */
function isNonNegInt(v) {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}
/** A positive SAFE integer (the strict v1.1 grid dim contract; Zod v4 .int()). */
function isPosInt(v) {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}
/** An array of strings (the strict `dashboardFilterMapping` contract). */
function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

// ──────────────────────────────────────────────────────────────────────────
// normalizeDashboardConfig — TOTAL transform to a strict-v1.1-valid DC.
// NEVER throws. Returns a config that ALWAYS passes DashboardConfigV1_1Schema.
// ──────────────────────────────────────────────────────────────────────────

/** A minimal VALID EMPTY dashboard (empty portlets is valid; superRefine is per-portlet). */
function minimalEmptyDc() {
  return { portlets: [], layoutMode: "grid", grid: { ...DEFAULT_GRID } };
}

/**
 * Normalize ONE portlet element to a strict `PortletConfigV1_1`-valid object.
 * `usedIds` enforces id UNIQUENESS within the DC: a kept non-empty id wins; a
 * missing/invalid id is generated from `idBase`+`index`; a collision (kept-vs-
 * generated or duplicate) gets suffixed in a loop until free [codex]. Normalized
 * fields WIN over the spread of original keys, so a typed-wrong
 * `w`/`dashboardFilterMapping`/`eagerLoad` can never be reintroduced [codex].
 * @returns {Record<string, unknown> | null} null when the element is unsalvageable.
 */
function normalizePortlet(raw, idBase, index, usedIds) {
  if (!isPlainObject(raw)) return null; // a non-object portlet can't become valid; DROP it.
  const elem = raw;

  // id: keep a non-empty string, else generate deterministically; ensure unique.
  let id = isNonEmptyString(elem.id) ? elem.id : `p-${idBase}-${index}`;
  if (usedIds.has(id)) {
    let n = index;
    let candidate = `${id}-${n}`;
    while (usedIds.has(candidate)) {
      n += 1;
      candidate = `${id}-${n}`;
    }
    id = candidate;
  }
  usedIds.add(id);

  // title: keep a non-empty string, else fall back to the (guaranteed non-empty) id.
  const title = isNonEmptyString(elem.title) ? elem.title : id;

  // w/h/x/y: keep a nonnegative finite int, else 0.
  const w = isNonNegInt(elem.w) ? elem.w : 0;
  const h = isNonNegInt(elem.h) ? elem.h : 0;
  const x = isNonNegInt(elem.x) ? elem.x : 0;
  const y = isNonNegInt(elem.y) ? elem.y : 0;

  // Start from a passthrough copy, THEN overwrite constrained fields so the
  // normalized values WIN (object spread order matters — codex SHOULD-FIX).
  const out = { ...elem, id, title, w, h, x, y };

  // dashboardFilterMapping: keep ONLY a string[]; else [] (drops "bad"/mixed).
  if (elem.dashboardFilterMapping !== undefined) {
    out.dashboardFilterMapping = isStringArray(elem.dashboardFilterMapping)
      ? elem.dashboardFilterMapping
      : [];
  }
  // eagerLoad (portlet): keep iff boolean, else DROP the optional key.
  if (elem.eagerLoad !== undefined && typeof elem.eagerLoad !== "boolean") {
    delete out.eagerLoad;
  }

  // content spec (superRefine): need analysisConfig !== undefined OR query !==
  // undefined [codex SHOULD-FIX: Zod-undefined semantics, not mere presence].
  if (out.analysisConfig === undefined && out.query === undefined) {
    out.analysisConfig = {};
  }
  return out;
}

/**
 * TOTAL normalizer: raw legacy config -> a strict-v1.1-valid DC. NEVER throws.
 * Logs are BOUNDED (rowId + reason + counts; never full JSON) via `onWarn`.
 * @param {unknown} raw
 * @param {{ idBase?: string, onWarn?: (msg: string) => void }} [ctx]
 * @returns {Record<string, unknown>}
 */
export function normalizeDashboardConfig(raw, { idBase, onWarn } = {}) {
  const base = String(idBase ?? "row");
  const warn = typeof onWarn === "function" ? onWarn : () => {};
  try {
    if (!isPlainObject(raw)) {
      warn(`row ${base}: root config is ${raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw} -> minimal-empty dashboard`);
      return minimalEmptyDc();
    }
    const src = raw;
    const out = { ...src }; // passthrough copy; constrained fields overwritten below.

    // portlets: array required. Non-array -> []. Each element normalized; bad
    // elements dropped. One bad element can never throw the row.
    const usedIds = new Set();
    let droppedPortlets = 0;
    if (!Array.isArray(src.portlets)) {
      if (src.portlets !== undefined) warn(`row ${base}: portlets is not an array (${typeof src.portlets}) -> []`);
      out.portlets = [];
    } else {
      const next = [];
      for (let i = 0; i < src.portlets.length; i += 1) {
        let p;
        try {
          p = normalizePortlet(src.portlets[i], base, i, usedIds);
        } catch {
          p = null; // a field accessor on a hostile getter etc. — drop, never throw.
        }
        if (p === null) droppedPortlets += 1;
        else next.push(p);
      }
      if (droppedPortlets > 0) warn(`row ${base}: dropped ${droppedPortlets} unsalvageable portlet element(s)`);
      out.portlets = next;
    }

    // DC-root constrained fields. Each: keep-if-valid, else DROP (optional) —
    // except layoutMode, which we set to "grid" when present-but-invalid (the
    // explicit deterministic fallback). Dropping an optional invalid field
    // yields a valid (absent) config; coercing grid to defaults is unnecessary.
    if (src.layoutMode !== undefined && src.layoutMode !== "grid" && src.layoutMode !== "rows") {
      out.layoutMode = "grid";
    }
    if (src.grid !== undefined) {
      const g = src.grid;
      const gridOk =
        isPlainObject(g) && isPosInt(g.cols) && isPosInt(g.rowHeight) && isPosInt(g.minW) && isPosInt(g.minH);
      if (!gridOk) delete out.grid; // e.g. {cols:-1} -> absent (valid).
    }
    if (src.colorPalette !== undefined && typeof src.colorPalette !== "string") delete out.colorPalette; // drops 42.
    if (src.eagerLoad !== undefined && typeof src.eagerLoad !== "boolean") delete out.eagerLoad;
    if (src.thumbnailData !== undefined && typeof src.thumbnailData !== "string") delete out.thumbnailData;
    if (src.thumbnailUrl !== undefined && typeof src.thumbnailUrl !== "string") delete out.thumbnailUrl;
    if (src.layouts !== undefined && !isPlainObject(src.layouts)) delete out.layouts; // record only.

    return out;
  } catch (err) {
    // Outermost net: ANY unexpected throw -> minimal-empty (still valid). The
    // "total" guarantee holds even for a pathological input.
    warn(`row ${base}: normalize fell back to minimal-empty (${err && err.message ? String(err.message).slice(0, 80) : "unknown"})`);
    return minimalEmptyDc();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Envelope wrap + the bundled MINIMAL final validator (models assertConfigV12).
// ──────────────────────────────────────────────────────────────────────────

/** Map a row's owner_level/project to a v1.2 scopeLevel (parity with ownerLevelToScopeLevel). */
export function deriveScopeLevel({ ownerLevel, projectId, templateScope } = {}) {
  if (projectId != null || templateScope === "project") return "project";
  return V12_SCOPE_LEVELS.includes(ownerLevel) ? ownerLevel : "user";
}

/**
 * Wrap a normalized DC into the single-analytics-portlet v1.2 envelope, stamping
 * the migration marker at `portlets[0].config.__cinatraMigration` (codex). The
 * non-marker shape is byte-identical to `wrapDcAsV12`.
 */
export function wrapMigratedEnvelope(dc, scopeLevel) {
  return {
    apiVersion: V12_API_VERSION,
    scopeLevel,
    portlets: [
      {
        instanceId: ANALYTICS_INSTANCE_ID,
        kind: ANALYTICS_KIND,
        version: ANALYTICS_PORTLET_VERSION,
        slot: "fixed",
        config: { dashboard: dc, [MIGRATION_MARKER_KEY]: MIGRATION_MARKER_VALUE },
      },
    ],
  };
}

/**
 * BUNDLED replica of `DashboardConfigV1_1Schema` (the embedded `config.dashboard`
 * shape) as a boolean/error check — `.passthrough()` at the DC root AND each
 * portlet, strict on the constrained fields, with the per-portlet superRefine.
 * Pinned EQUIVALENT to the real schema by the unit test. Returns error strings.
 */
export function validateEmbeddedDcV1_1(dash) {
  if (!isPlainObject(dash)) return ["config.dashboard: required object"];
  const errors = [];
  if (!Array.isArray(dash.portlets)) {
    errors.push("portlets: expected array");
  } else {
    dash.portlets.forEach((p, i) => {
      if (!isPlainObject(p)) {
        errors.push(`portlets.${i}: expected object`);
        return;
      }
      if (!isNonEmptyString(p.id)) errors.push(`portlets.${i}.id: required non-empty`);
      if (!isNonEmptyString(p.title)) errors.push(`portlets.${i}.title: required non-empty`);
      for (const f of ["w", "h", "x", "y"]) if (!isNonNegInt(p[f])) errors.push(`portlets.${i}.${f}: nonnegative int`);
      if (p.dashboardFilterMapping !== undefined && !isStringArray(p.dashboardFilterMapping)) {
        errors.push(`portlets.${i}.dashboardFilterMapping: string[]`);
      }
      if (p.eagerLoad !== undefined && typeof p.eagerLoad !== "boolean") errors.push(`portlets.${i}.eagerLoad: boolean`);
      if (p.analysisConfig === undefined && p.query === undefined) {
        errors.push(`portlets.${i}: requires analysisConfig or query`);
      }
    });
  }
  // DC-root constrained fields.
  if (dash.layoutMode !== undefined && dash.layoutMode !== "grid" && dash.layoutMode !== "rows") {
    errors.push("layoutMode: grid|rows");
  }
  if (dash.grid !== undefined) {
    const g = dash.grid;
    if (!(isPlainObject(g) && isPosInt(g.cols) && isPosInt(g.rowHeight) && isPosInt(g.minW) && isPosInt(g.minH))) {
      errors.push("grid: {cols,rowHeight,minW,minH} positive ints");
    }
  }
  if (dash.colorPalette !== undefined && typeof dash.colorPalette !== "string") errors.push("colorPalette: string");
  if (dash.eagerLoad !== undefined && typeof dash.eagerLoad !== "boolean") errors.push("eagerLoad: boolean");
  if (dash.thumbnailData !== undefined && typeof dash.thumbnailData !== "string") errors.push("thumbnailData: string");
  if (dash.thumbnailUrl !== undefined && typeof dash.thumbnailUrl !== "string") errors.push("thumbnailUrl: string");
  if (dash.layouts !== undefined && !isPlainObject(dash.layouts)) errors.push("layouts: record");
  return errors;
}

/**
 * BUNDLED FINAL-GATE validator over THIS migration's own output surface — the
 * canonical single-analytics envelope `wrapMigratedEnvelope` produces (no
 * inputs/outputs wiring, no multi-portlet composition). It enforces the same
 * checks `mutation-service.ts::assertConfigV12` applies to that surface:
 * (1) structural v1.2 (`validateDashboardConfigV12`: strict root/portlet shape,
 * scopeLevel enum, UNIQUE instanceIds, known kind), PLUS (2) the analytics kind's
 * deep `config.dashboard` validation (`validateAnalyticsPortletConfig` ->
 * `DashboardConfigV1_1Schema`). Pure JS, no zod. Returns
 * `{ ok: boolean, errors: string[] }`.
 *
 * It is NOT a general-purpose replica of assertConfigV12 for ARBITRARY v1.2
 * configs: it deliberately does NOT model the input/output binding-wiring
 * cross-checks `validateDashboardConfigV12` runs (fromInstanceId/fromDashboard,
 * declared input/output keys), because a migrated row NEVER carries `inputs`/
 * `outputs` — so this validator REJECTS those keys (their presence would be a
 * migration bug). Outside the migration's surface it is therefore strictly
 * TIGHTER than assertConfigV12 (rejects more), which is the SAFE direction for a
 * final gate: it can only ever over-reject (→ abort), never under-reject a row
 * the app would refuse. The equivalence test (`migration-v12-bundled-normalizer
 * .test.ts`) proves it AGREES with the real validators on the migration's own
 * valid/invalid surface, and that the bundled DC check agrees with the real
 * `DashboardConfigV1_1Schema` — so the bundle can't silently drift [codex
 * MERGE-SAFE SHOULD-FIX: scoped the equivalence claim honestly].
 */
export function validateMigratedEnvelopeV12(config) {
  const errors = [];
  if (!isPlainObject(config)) return { ok: false, errors: ["<root>: not an object"] };
  if (config.apiVersion !== V12_API_VERSION) errors.push(`<root>.apiVersion: expected "${V12_API_VERSION}"`);
  if (!V12_SCOPE_LEVELS.includes(config.scopeLevel)) errors.push(`<root>.scopeLevel: invalid "${String(config.scopeLevel)}"`);
  // The real v1.2 root schema is `.strict()` — only these three keys. Reject
  // strays (parity with dashboardConfigV12Schema.strict()) [codex non-blocking].
  for (const k of Object.keys(config)) {
    if (k !== "apiVersion" && k !== "scopeLevel" && k !== "portlets") errors.push(`<root>: unrecognized key "${k}"`);
  }
  if (!Array.isArray(config.portlets)) {
    errors.push("<root>.portlets: expected array");
    return { ok: false, errors };
  }

  const seen = new Set();
  config.portlets.forEach((p, i) => {
    if (!isPlainObject(p)) {
      errors.push(`portlets.${i}: expected object`);
      return;
    }
    // strict portlet shape (the keys portletConfigV12Schema permits).
    if (!isNonEmptyString(p.instanceId)) errors.push(`portlets.${i}.instanceId: required`);
    if (!isNonEmptyString(p.kind)) errors.push(`portlets.${i}.kind: required`);
    if (!isNonEmptyString(p.version)) errors.push(`portlets.${i}.version: required`);
    if (p.slot !== "fixed" && p.slot !== "optional") errors.push(`portlets.${i}.slot: expected fixed|optional`);
    if (p.config !== undefined && !isPlainObject(p.config)) errors.push(`portlets.${i}.config: expected object`);
    // A migrated portlet carries ONLY {instanceId,kind,version,slot,config}.
    // `inputs`/`outputs` are valid v1.2 keys in GENERAL, but the migration never
    // emits them — their presence here is a bug, so reject (final-gate tight).
    const allowed = new Set(["instanceId", "kind", "version", "slot", "config"]);
    for (const k of Object.keys(p)) if (!allowed.has(k)) errors.push(`portlets.${i}: unexpected key "${k}" for a migrated portlet`);
    // unique instanceId.
    if (isNonEmptyString(p.instanceId)) {
      if (seen.has(p.instanceId)) errors.push(`duplicate portlet instanceId "${p.instanceId}"`);
      seen.add(p.instanceId);
    }
    // known kind/version (this bundle knows the analytics kind + alias; the
    // migration never emits another kind, so anything else is unknown).
    const isAnalytics = p.kind === ANALYTICS_KIND || p.kind === ANALYTICS_KIND_ALIAS;
    if (!(isAnalytics && p.version === ANALYTICS_PORTLET_VERSION)) {
      errors.push(`portlets.${i}: references unknown kind/version "${String(p.kind)}@${String(p.version)}"`);
    } else {
      // analytics deep check: config.dashboard must pass DashboardConfigV1_1Schema.
      const dash = isPlainObject(p.config) ? p.config.dashboard : undefined;
      for (const e of validateEmbeddedDcV1_1(dash)) errors.push(`portlet "${String(p.instanceId)}": ${e}`);
    }
  });
  return { ok: errors.length === 0, errors };
}

/**
 * Full per-row pipeline (pure, deterministic, no I/O): raw -> normalize -> wrap
 * -> FINAL VALIDATE. Throws (aborting the tx) if the wrapped envelope fails the
 * bundled validator — a migration bug, which the total guarantee precludes.
 * @returns {Record<string, unknown>} the validated v1.2 envelope.
 */
export function buildMigratedEnvelope(rawConfig, scopeArgs, idBase, onWarn) {
  const dc = normalizeDashboardConfig(rawConfig, { idBase, onWarn });
  const scopeLevel = deriveScopeLevel(scopeArgs);
  const envelope = wrapMigratedEnvelope(dc, scopeLevel);
  const res = validateMigratedEnvelopeV12(envelope);
  if (!res.ok) {
    throw new Error(
      `[core__0006] FINAL VALIDATION failed for row ${idBase} — migration bug, aborting transaction: ${res.errors.slice(0, 6).join("; ")}`,
    );
  }
  return envelope;
}

// ──────────────────────────────────────────────────────────────────────────
// Migration up()/down() — async; JS normalize inside the runner transaction.
// ──────────────────────────────────────────────────────────────────────────

const LEGACY_VERSIONS = ["1.0.0", "1.1.0"];

// node-pg-migrate runs an async `up(pgm)` BEFORE wrapping anything in a
// transaction, and `pgm.db.query` executes IMMEDIATELY on the runner's client in
// AUTOCOMMIT mode (the runner's `singleTransaction` only wraps QUEUED `pgm.sql`
// steps, of which this migration has none). So `LOCK TABLE` would error
// ("can only be used in transaction blocks") and the row UPDATEs would not be
// atomic. We therefore declare `pgm.noTransaction()` (node-pg-migrate must NOT
// open its own transaction around us) and OWN an explicit BEGIN/COMMIT/ROLLBACK
// via `pgm.db.query`, so the LOCK + normalize-rewrites + default-flip +
// postcondition are ONE atomic unit; any throw ROLLBACKs and fails the migration
// (no ledger row is written). [Found by the real-Postgres proof.]

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export async function up(pgm) {
  pgm.noTransaction(); // we manage the transaction ourselves (see note above).
  const warnings = [];
  const onWarn = (m) => {
    if (warnings.length < 50) warnings.push(m);
  };

  await pgm.db.query("BEGIN");
  try {
    // Block concurrent app writes + DDL for the duration of the migration (codex
    // BLOCKER): the runner's advisory lock serializes schema work, not dashboard
    // writes. SHARE ROW EXCLUSIVE allows concurrent reads but blocks writers.
    await pgm.db.query(`LOCK TABLE dashboards, dashboard_revisions IN SHARE ROW EXCLUSIVE MODE`);

    // 1. dashboards: SELECT legacy rows, normalize in JS, parameterized UPDATE by id.
    const dRows = await pgm.db.query(
      `SELECT id, config_json, owner_level, project_id, template_scope
         FROM dashboards
        WHERE config_version = ANY($1::text[])`,
      [LEGACY_VERSIONS],
    );
    for (const r of dRows.rows) {
      const envelope = buildMigratedEnvelope(
        r.config_json,
        { ownerLevel: r.owner_level, projectId: r.project_id, templateScope: r.template_scope },
        `dashboards:${r.id}`,
        onWarn,
      );
      await pgm.db.query(
        `UPDATE dashboards
            SET config_json = $1::jsonb, config_version = $2
          WHERE id = $3 AND config_version = ANY($4::text[])`,
        [JSON.stringify(envelope), V12_API_VERSION, r.id, LEGACY_VERSIONS],
      );
    }

    // 2. dashboard_revisions: revisions carry no scope columns — JOIN the parent
    //    dashboards row for scope. SELECT legacy revisions + parent scope, normalize,
    //    UPDATE by (dashboard_id, revision_number). An orphan revision (no parent)
    //    is excluded by the inner JOIN — impossible under the FK, but defensive.
    const rRows = await pgm.db.query(
      `SELECT r.dashboard_id, r.revision_number, r.config_json,
              d.owner_level, d.project_id, d.template_scope
         FROM dashboard_revisions r
         JOIN dashboards d ON d.id = r.dashboard_id
        WHERE r.config_version = ANY($1::text[])`,
      [LEGACY_VERSIONS],
    );
    for (const r of rRows.rows) {
      const envelope = buildMigratedEnvelope(
        r.config_json,
        { ownerLevel: r.owner_level, projectId: r.project_id, templateScope: r.template_scope },
        `dashboard_revisions:${r.dashboard_id}#${r.revision_number}`,
        onWarn,
      );
      await pgm.db.query(
        `UPDATE dashboard_revisions
            SET config_json = $1::jsonb, config_version = $2
          WHERE dashboard_id = $3 AND revision_number = $4 AND config_version = ANY($5::text[])`,
        [JSON.stringify(envelope), V12_API_VERSION, r.dashboard_id, r.revision_number, LEGACY_VERSIONS],
      );
    }

    // 3. Flip the EXISTING-DB column default for dashboards.config_version
    //    ('1.0.0' -> 'v1.2'), guarded so it is a no-op when already 'v1.2'.
    await pgm.db.query(`DO $$
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

    // 4. ZERO-LEGACY postcondition (codex BLOCKER): after the migration, NO legacy
    //    row/revision may remain. If any does, THROW to ROLLBACK the transaction.
    const leftover = await pgm.db.query(
      `SELECT
          (SELECT COUNT(*) FROM dashboards          WHERE config_version = ANY($1::text[])) AS d,
          (SELECT COUNT(*) FROM dashboard_revisions WHERE config_version = ANY($1::text[])) AS r`,
      [LEGACY_VERSIONS],
    );
    const left = leftover.rows[0];
    if (Number(left.d) !== 0 || Number(left.r) !== 0) {
      throw new Error(
        `[core__0006] postcondition failed: ${left.d} legacy dashboards + ${left.r} legacy revisions remain after up() — aborting transaction`,
      );
    }

    await pgm.db.query("COMMIT");

    if (warnings.length > 0) {
      // Bounded, no full JSON — surfaced for ops visibility.
      console.warn(
        `[core__0006] normalized ${dRows.rows.length} dashboards + ${rRows.rows.length} revisions with ${warnings.length} bounded repair note(s): ${warnings.slice(0, 10).join(" | ")}`,
      );
    }
  } catch (err) {
    await pgm.db.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export async function down(pgm) {
  pgm.noTransaction(); // own the transaction (same node-pg-migrate note as up()).

  const guard = (alias) => `
        ${alias}.config_version = '${V12_API_VERSION}'
    AND jsonb_typeof(${alias}.config_json -> 'portlets') = 'array'
    AND jsonb_array_length(${alias}.config_json -> 'portlets') = 1
    AND (${alias}.config_json -> 'portlets' -> 0 ->> 'kind') = '${ANALYTICS_KIND}'
    AND (${alias}.config_json -> 'portlets' -> 0 -> 'config' ->> '${MIGRATION_MARKER_KEY}') = '${MIGRATION_MARKER_VALUE}'
    AND (${alias}.config_json -> 'portlets' -> 0 -> 'config' -> 'dashboard') IS NOT NULL`;

  await pgm.db.query("BEGIN");
  try {
    // Reverse — but ONLY rows THIS migration produced, keyed on the marker at
    // portlets[0].config.__cinatraMigration (codex BLOCKER): a NATIVE #326
    // single-analytics operator v1.2 row carries NO marker and is left untouched,
    // as are multi-portlet operator rows and extension rows. Lock first (same
    // concurrency reasoning as up()).
    await pgm.db.query(`LOCK TABLE dashboards, dashboard_revisions IN SHARE ROW EXCLUSIVE MODE`);

    // 1. dashboard_revisions first (FK child): revert only when its PARENT is a
    //    marked migrated operator row. Restore the bare DC + '1.1.0'.
    await pgm.db.query(`UPDATE dashboard_revisions r
         SET config_json = (r.config_json -> 'portlets' -> 0 -> 'config' -> 'dashboard'),
             config_version = '1.1.0'
        FROM dashboards d
       WHERE r.dashboard_id = d.id
         AND d.extension_id IS NULL
         AND ${guard("r")}`);

    // 2. dashboards: unwrap portlets[0].config.dashboard back to root, restore '1.1.0'.
    await pgm.db.query(`UPDATE dashboards
         SET config_json = (config_json -> 'portlets' -> 0 -> 'config' -> 'dashboard'),
             config_version = '1.1.0'
       WHERE extension_id IS NULL
         AND ${guard("dashboards")}`);

    // 3. Reset the EXISTING-DB column default to the legacy '1.0.0' (guarded).
    await pgm.db.query(`DO $$
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

    await pgm.db.query("COMMIT");
  } catch (err) {
    await pgm.db.query("ROLLBACK").catch(() => {});
    throw err;
  }
}
