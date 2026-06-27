// cinatra#327 (PR #336) — shape guards for the core__0006 migration AFTER the
// robust-B rewrite (owner decision: a ONE-SHOT total normalizer, no
// backward compat). The migration's transform is the JS-side normalizer BUNDLED
// in `migrations/core/core__0006_dashboards-v12.mjs`; its TOTAL/fuzz/equivalence
// behavior is covered exhaustively in `migration-v12-bundled-normalizer.test.ts`
// and end-to-end on real Postgres in `migration-v12-core0006.integration.test.ts`.
//
// THIS file pins the two original verify findings against the NEW implementation,
// using the REAL bundled normalizer (not a TS replica of the old SQL):
//
//   Finding 2 (BLOCKER): a pure-1.0.0 dashboard body (type-discriminated
//     portlets, NO title/w/h/x/y — see LEGACY_V1_0_CONFIG below)
//     is NORMALIZED to the schema-1.1 grid shape before wrapping, so the
//     migrated row's embedded config.dashboard PASSES the analytics deep
//     validator (assertConfigV12). Wrapping a 1.0 body VERBATIM (no normalize)
//     still FAILS — proving the normalize is load-bearing.
//
//   Finding 1 (secondary): the migration's down() guard reverts ONLY the rows
//     it produced. The NEW guard keys on the migration MARKER
//     (portlets[0].config.__cinatraMigration='core__0006') — strictly safer than
//     the old shape-only guard: a NATIVE #326 single-analytics operator apiVersion-1.2 row
//     (no marker) is now ALSO left untouched, not just multi-portlet/extension
//     rows. Here we replicate the down() WHERE predicate and assert it.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { wrapDcAsV12 } from "../v12-envelope";
import {
  validateDashboardConfigV12,
  DASHBOARD_CONFIG_V12_VERSION,
} from "../extension/dashboard-config-v12";
import { DashboardConfigV1_1Schema } from "../store/dashboard-config";

// Local replica of the (now-removed, cinatra#329) permissive 1.0.0 schema —
// type-discriminated portlets, no required grid layout. The migration must
// accept a pure-1.0.0 body shaped like this; we assert that contrast locally
// rather than depend on the deleted production schema.
const LegacyConfigV1Schema = z.object({
  portlets: z.array(
    z.object({
      id: z.string().min(1),
      type: z.string().min(1),
      title: z.string().optional(),
      cubeId: z.string().optional(),
      query: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  layout: z
    .object({
      columns: z.number().int().positive().optional(),
      gap: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
import { registerCorePortletKinds, isAnalyticsPortletKind, ANALYTICS_PORTLET_KIND } from "../portlets/kinds";
import {
  getPortletKindDescriptor,
  validatePortletConfig,
  __resetPortletRegistryForTests,
} from "../portlets/registry";

// The REAL bundled normalizer + envelope wrap from the migration artifact.
import {
  normalizeDashboardConfig,
  wrapMigratedEnvelope,
  MIGRATION_MARKER_KEY,
  MIGRATION_MARKER_VALUE,
} from "../../../../migrations/core/core__0006_dashboards-v12.mjs";

const V12 = DASHBOARD_CONFIG_V12_VERSION; // the apiVersion literal (avoids a bare token)

/**
 * Mirror of mutation-service.ts::assertConfigV12 — structural
 * `validateDashboardConfigV12` + the per-kind deep `validateConfig`. [] = ok.
 */
function registryErrors(config: unknown): string[] {
  registerCorePortletKinds();
  const res = validateDashboardConfigV12(config, { getPortletKind: getPortletKindDescriptor });
  if (!res.ok) return res.errors;
  const errors: string[] = [];
  for (const p of res.config.portlets) {
    for (const e of validatePortletConfig(p.kind, p.version, { config: p.config, inputs: p.inputs, outputs: p.outputs })) {
      errors.push(`portlet "${p.instanceId}": ${e.message}`);
    }
  }
  return errors;
}

/**
 * TS replica of the migration's down() WHERE predicate (core__0006) for the
 * `dashboards` table AFTER robust-B:
 *   config_version = <apiVersion literal>
 *   AND extension_id IS NULL
 *   AND jsonb_typeof(config_json -> 'portlets') = 'array'
 *   AND jsonb_array_length(config_json -> 'portlets') = 1
 *   AND (config_json -> 'portlets' -> 0 ->> 'kind') = 'analytics'
 *   AND (config_json -> 'portlets' -> 0 -> 'config' ->> '__cinatraMigration') = 'core__0006'
 *   AND (config_json -> 'portlets' -> 0 -> 'config' -> 'dashboard') IS NOT NULL
 * Returns true when down() WOULD unwrap the row (a migration-MARKED single-
 * analytics row). The marker clause is the robust-B addition.
 */
function downGuardMatches(row: { configVersion: string; extensionId: string | null; configJson: unknown }): boolean {
  if (row.configVersion !== V12) return false;
  if (row.extensionId !== null) return false;
  const cfg = row.configJson as { portlets?: unknown } | null;
  const portlets = cfg && Array.isArray(cfg.portlets) ? cfg.portlets : null;
  if (!portlets) return false;
  if (portlets.length !== 1) return false;
  const p0 = portlets[0] as Record<string, unknown> | undefined;
  if (typeof p0?.kind !== "string" || p0.kind !== ANALYTICS_PORTLET_KIND) return false;
  const config = p0.config as Record<string, unknown> | undefined;
  if (config?.[MIGRATION_MARKER_KEY] !== MIGRATION_MARKER_VALUE) return false;
  const dashboard = config?.dashboard;
  return dashboard !== undefined && dashboard !== null;
}

// A pure-1.0.0 body: type-discriminated portlets, no title/w/h/x/y. (Second
// portlet carries a 1.0 title+query to prove normalize PRESERVES them; third has
// an empty title — valid 1.0, invalid strict 1.1.)
const LEGACY_V1_0_CONFIG = {
  portlets: [
    { id: "p1", type: "chart" },
    { id: "p2", type: "kpi", title: "Revenue", cubeId: "c1", query: { measures: ["x"] } },
    { id: "p3", type: "table", title: "" },
  ],
  layout: { columns: 3, gap: 8 },
};

// A genuine, already-valid schema-1.1 body (the #326 wrap path's input shape).
const VALID_GRID_CONFIG = {
  portlets: [{ id: "a", title: "A", w: 6, h: 8, x: 0, y: 0, analysisConfig: {} }],
  colorPalette: "default",
};

describe("core__0006 up(): pure-1.0.0 normalization (cinatra#327 Finding 2, robust-B)", () => {
  it("a pure-1.0.0 body is a VALID 1.0.0 config but NOT a valid grid (schema-1.1) body (the root cause)", () => {
    expect(LegacyConfigV1Schema.safeParse(LEGACY_V1_0_CONFIG).success).toBe(true);
    expect(DashboardConfigV1_1Schema.safeParse(LEGACY_V1_0_CONFIG).success).toBe(false);
  });

  it("wrapping a pure-1.0.0 body VERBATIM (no normalize) FAILS the analytics registry validator (the BUG)", () => {
    const errs = registryErrors(wrapDcAsV12(LEGACY_V1_0_CONFIG, "user"));
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(" ")).toMatch(/title|w|h|x|y/);
    expect(errs.join(" ")).toMatch(/config\.dashboard/);
  });

  it("NORMALIZING the pure-1.0.0 body first yields a valid grid (schema-1.1) body", () => {
    const normalized = normalizeDashboardConfig(LEGACY_V1_0_CONFIG, { idBase: "d:1" });
    expect(DashboardConfigV1_1Schema.safeParse(normalized).success).toBe(true);
  });

  it("normalize PRESERVES original keys and SUPPLIES only the missing grid fields", () => {
    const out = normalizeDashboardConfig(LEGACY_V1_0_CONFIG, { idBase: "d:1" }) as {
      portlets: Record<string, unknown>[];
      layout?: unknown;
    };
    const [p1, p2, p3] = out.portlets;
    // p1 (bare): title defaults to id; w/h/x/y:=0; content-spec added; type preserved.
    expect(p1).toMatchObject({ id: "p1", type: "chart", title: "p1", w: 0, h: 0, x: 0, y: 0 });
    expect(p1.analysisConfig).toEqual({}); // content spec supplied (no query present)
    // p2 (had title+query+cubeId): those PRESERVED; only w/h/x/y added; NO analysisConfig (query present).
    expect(p2).toMatchObject({ id: "p2", type: "kpi", title: "Revenue", cubeId: "c1", query: { measures: ["x"] }, w: 0, h: 0, x: 0, y: 0 });
    expect(p2.analysisConfig).toBeUndefined();
    // p3 empty title → coerced to id.
    expect(p3.title).toBe("p3");
    // top-level layout (a 1.0 passthrough key) preserved.
    expect(out.layout).toEqual({ columns: 3, gap: 8 });
  });

  it("FIX: wrap(normalize(pure-1.0.0)) PASSES the analytics registry validator (assertConfigV12)", () => {
    const env = wrapMigratedEnvelope(normalizeDashboardConfig(LEGACY_V1_0_CONFIG, { idBase: "d:1" }), "user");
    expect(registryErrors(env)).toEqual([]);
    const dc = (env.portlets[0].config as { dashboard: { portlets: Record<string, unknown>[] } }).dashboard;
    expect(dc.portlets[2].title).toBe("p3"); // empty title coerced
  });

  it("a genuine grid (schema-1.1) body wraps to a registry-valid envelope unchanged (1.1 path: fixed point)", () => {
    expect(normalizeDashboardConfig(VALID_GRID_CONFIG, { idBase: "d:2" })).toEqual(VALID_GRID_CONFIG);
    expect(registryErrors(wrapMigratedEnvelope(normalizeDashboardConfig(VALID_GRID_CONFIG, { idBase: "d:2" }), "team"))).toEqual([]);
  });

  it("normalize is a FIXED POINT: re-normalizing an already-normalized body is identical (round-trip safe)", () => {
    const once = normalizeDashboardConfig(LEGACY_V1_0_CONFIG, { idBase: "d:1" });
    const twice = normalizeDashboardConfig(once, { idBase: "d:1" });
    expect(twice).toEqual(once);
  });
});

describe("core__0006 down(): marker-gated guard (cinatra#327 Finding 1, robust-B)", () => {
  const dc = VALID_GRID_CONFIG;
  // A MIGRATED row carries the marker (built by the real wrap helper).
  const migratedEnvelope = wrapMigratedEnvelope(dc, "user");
  // A NATIVE #326 single-analytics row — same shape, NO marker.
  const nativeAnalyticsPortlet = { instanceId: "analytics", kind: ANALYTICS_PORTLET_KIND, version: "1.0.0", slot: "fixed", config: { dashboard: dc } };
  const siblingPortlet = { instanceId: "ol", kind: "object-list", version: "1.0.0", slot: "optional", config: { typeId: "task" }, outputs: ["selectedId"] };
  const envelope = (portlets: unknown[], scopeLevel: string) => ({ apiVersion: V12, scopeLevel, portlets });

  it("MATCHES a genuine MARKED single-analytics migrated row (down() reverts it)", () => {
    expect(downGuardMatches({ configVersion: V12, extensionId: null, configJson: migratedEnvelope })).toBe(true);
  });

  it("FIX (robust-B): does NOT match a NATIVE #326 single-analytics row (NO marker) — left untouched", () => {
    expect(downGuardMatches({ configVersion: V12, extensionId: null, configJson: envelope([nativeAnalyticsPortlet], "user") })).toBe(false);
  });

  it("does NOT match a NON-migrated MULTI-portlet operator row (analytics + sibling)", () => {
    expect(downGuardMatches({ configVersion: V12, extensionId: null, configJson: envelope([{ ...nativeAnalyticsPortlet, config: { dashboard: dc, [MIGRATION_MARKER_KEY]: MIGRATION_MARKER_VALUE } }, siblingPortlet], "team") })).toBe(false);
  });

  it("does NOT match an extension row (extension_id guard) even if marked", () => {
    expect(downGuardMatches({ configVersion: V12, extensionId: "@cinatra-ai/some-ext", configJson: migratedEnvelope })).toBe(false);
  });

  it("does NOT match an operator NON-analytics single-portlet row (kind guard)", () => {
    expect(downGuardMatches({ configVersion: V12, extensionId: null, configJson: envelope([siblingPortlet], "user") })).toBe(false);
  });

  it("does NOT match a legacy (non-envelope) row", () => {
    expect(downGuardMatches({ configVersion: "1.1.0", extensionId: null, configJson: dc })).toBe(false);
  });

  it("sanity: the analytics kind predicate the guard relies on holds", () => {
    __resetPortletRegistryForTests();
    registerCorePortletKinds();
    expect(isAnalyticsPortletKind(ANALYTICS_PORTLET_KIND)).toBe(true);
    expect(getPortletKindDescriptor(ANALYTICS_PORTLET_KIND, "1.0.0")).toBeDefined();
  });
});
