// cinatra#327 (PR #336) — unit guards for the two verify findings the original
// core__0006 migration tests missed. The migration itself is SQL in
// `migrations/core/core__0006_dashboards-v12.mjs`; its end-to-end behavior is
// proven against real Postgres by the gated integration proof
// (`migration-v12-core0006.integration.test.ts` + the lane's real-db harness).
// THIS file is a fast, Postgres-free regression guard that pins the two
// load-bearing transform contracts using the SAME registry validator the
// migration's output must satisfy at rest:
//
//   Finding 2 (BLOCKER): a pure-1.0.0 dashboard body (type-discriminated
//     portlets, NO title/w/h/x/y — the `render-kind.test.ts` LEGACY_V1_0_CONFIG
//     shape) wrapped VERBATIM into the analytics envelope FAILS the analytics
//     kind's deep `config.dashboard` validation. The migration must UP-CONVERT
//     a 1.0.0 body to the schema-1.1 grid shape BEFORE wrapping. Here we
//     replicate that SQL up-convert in TS and assert the wrapped result PASSES
//     `assertConfigV12` (and that the verbatim wrap FAILS — proving the
//     up-convert is necessary, not incidental).
//
//   Finding 1 (secondary): the migration's down() guard must match ONLY the
//     single-analytics-portlet rows it produced — a NON-migrated multi-portlet
//     operator (apiVersion-1.2) row (analytics-first + a sibling portlet,
//     producible via #326 `reEnvelopeDcSave`) must be LEFT UNTOUCHED. Here we
//     replicate the down() WHERE predicate and assert it excludes that
//     multi-portlet row (and an extension row, and a non-analytics row) while
//     matching a genuine single-analytics migrated row.
//
// The TS replicas below mirror, expression-for-expression, the SQL in
// core__0006 (`upconvertV1_0ToV1_1Expr` and the down() WHERE clause). If the
// SQL changes, the real-db proof catches it; these guard the logic cheaply.
import { describe, expect, it } from "vitest";

import { wrapDcAsV12 } from "../v12-envelope";
import {
  validateDashboardConfigV12,
  DASHBOARD_CONFIG_V12_VERSION,
} from "../extension/dashboard-config-v12";
import {
  DashboardConfigV1Schema,
  DashboardConfigV1_1Schema,
} from "../store/dashboard-config";
import { registerCorePortletKinds, isAnalyticsPortletKind, ANALYTICS_PORTLET_KIND } from "../portlets/kinds";
import {
  getPortletKindDescriptor,
  validatePortletConfig,
  __resetPortletRegistryForTests,
} from "../portlets/registry";

const V12 = DASHBOARD_CONFIG_V12_VERSION; // the apiVersion literal (avoids a bare token)

/**
 * Mirror of mutation-service.ts::assertConfigV12 — the EXACT registry
 * validation an extension dashboard config must pass at the write site AND that
 * a migrated core__0006 row must satisfy at rest: structural
 * `validateDashboardConfigV12` + the per-kind deep `validateConfig` (for the
 * analytics kind, `config.dashboard` against the strict
 * `DashboardConfigV1_1Schema`). Returns the collected error strings ([] = ok).
 */
function registryErrors(config: unknown): string[] {
  registerCorePortletKinds();
  const res = validateDashboardConfigV12(config, { getPortletKind: getPortletKindDescriptor });
  if (!res.ok) return res.errors;
  const errors: string[] = [];
  for (const p of res.config.portlets) {
    for (const e of validatePortletConfig(p.kind, p.version, {
      config: p.config,
      inputs: p.inputs,
      outputs: p.outputs,
    })) {
      errors.push(`portlet "${p.instanceId}": ${e.message}`);
    }
  }
  return errors;
}

/**
 * TS replica of the migration's `upconvertV1_0ToV1_1Expr` SQL (core__0006).
 * Per portlet: `elem || { title := COALESCE(NULLIF(title,''), id),
 * w/h/x/y := 0, query := COALESCE(query, {}) }` — jsonb concat where the added
 * object only supplies COALESCE fallbacks, so original keys (`type`, `cubeId`,
 * a NON-EMPTY existing `title`/`query`) win; the top-level config (incl. a
 * 1.0.0 `layout`) is preserved (jsonb_set on `{portlets}` only). A non-array
 * `portlets` degrades to `[]`. A schema-1.1 row does NOT pass through this
 * (wrapped verbatim). NULLIF(title,'') because the 1.0 schema permits an empty
 * title that the strict v1.1 title.min(1) rejects.
 */
function upconvertV1_0ToV1_1(cfg: Record<string, unknown>): Record<string, unknown> {
  const portlets = Array.isArray(cfg.portlets) ? cfg.portlets : [];
  const nullifEmpty = (s: unknown) => (s === "" ? null : s); // NULLIF(title,'')
  return {
    ...cfg,
    portlets: portlets.map((p) => {
      const elem = p as Record<string, unknown>;
      return {
        ...elem,
        title: nullifEmpty(elem.title) ?? elem.id,
        w: 0,
        h: 0,
        x: 0,
        y: 0,
        query: elem.query ?? {},
      };
    }),
  };
}

/**
 * TS replica of the migration's down() WHERE predicate (core__0006) for the
 * `dashboards` table:
 *   config_version = <apiVersion literal>
 *   AND extension_id IS NULL
 *   AND jsonb_typeof(config_json -> 'portlets') = 'array'
 *   AND jsonb_array_length(config_json -> 'portlets') = 1
 *   AND (config_json -> 'portlets' -> 0 ->> 'kind') = 'analytics'
 *   AND (config_json -> 'portlets' -> 0 -> 'config' -> 'dashboard') IS NOT NULL
 * Returns true when down() WOULD unwrap the row (i.e. it is a migration-produced
 * single-analytics row). The migration only ever produced single-analytics rows.
 */
function downGuardMatches(row: {
  configVersion: string;
  extensionId: string | null;
  configJson: unknown;
}): boolean {
  if (row.configVersion !== V12) return false;
  if (row.extensionId !== null) return false;
  const cfg = row.configJson as { portlets?: unknown } | null;
  const portlets = cfg && Array.isArray(cfg.portlets) ? cfg.portlets : null;
  if (!portlets) return false;
  if (portlets.length !== 1) return false;
  const p0 = portlets[0] as Record<string, unknown> | undefined;
  if (typeof p0?.kind !== "string" || p0.kind !== ANALYTICS_PORTLET_KIND) return false;
  const dashboard = (p0.config as Record<string, unknown> | undefined)?.dashboard;
  return dashboard !== undefined && dashboard !== null;
}

// The render-kind.test.ts LEGACY_V1_0_CONFIG shape: type-discriminated portlets,
// no title/w/h/x/y. (Second portlet carries a 1.0 title+query to prove the
// up-convert PRESERVES them rather than overwriting.)
const LEGACY_V1_0_CONFIG = {
  portlets: [
    { id: "p1", type: "chart" },
    { id: "p2", type: "kpi", title: "Revenue", cubeId: "c1", query: { measures: ["x"] } },
    // EMPTY-title portlet — reachable (the 1.0 schema permits title:""); the
    // strict v1.1 title.min(1) rejects "", so the up-convert MUST coerce it to
    // id via NULLIF [codex merge-safe corner].
    { id: "p3", type: "table", title: "" },
  ],
  layout: { columns: 3, gap: 8 },
};

// A genuine, already-valid schema-1.1 body (the #326 wrap path's input shape).
const VALID_GRID_CONFIG = {
  portlets: [{ id: "a", title: "A", w: 6, h: 8, x: 0, y: 0, analysisConfig: {} }],
  colorPalette: "default",
};

describe("core__0006 up(): 1.0.0 schema up-convert (cinatra#327 Finding 2)", () => {
  it("a pure-1.0.0 body is a VALID 1.0.0 config but NOT a valid grid (schema-1.1) body (the root cause)", () => {
    expect(DashboardConfigV1Schema.safeParse(LEGACY_V1_0_CONFIG).success).toBe(true);
    expect(DashboardConfigV1_1Schema.safeParse(LEGACY_V1_0_CONFIG).success).toBe(false);
  });

  it("wrapping a pure-1.0.0 body VERBATIM FAILS the analytics registry validator (the BUG)", () => {
    const errs = registryErrors(wrapDcAsV12(LEGACY_V1_0_CONFIG, "user"));
    expect(errs.length).toBeGreaterThan(0);
    // The exact failure the verify finding reported: missing grid layout fields.
    expect(errs.join(" ")).toMatch(/title|w|h|x|y/);
    expect(errs.join(" ")).toMatch(/config\.dashboard/);
  });

  it("UP-CONVERTING the pure-1.0.0 body first yields a valid grid (schema-1.1) body", () => {
    const upconverted = upconvertV1_0ToV1_1(LEGACY_V1_0_CONFIG);
    expect(DashboardConfigV1_1Schema.safeParse(upconverted).success).toBe(true);
  });

  it("the up-convert PRESERVES original keys and SUPPLIES only the missing grid fields", () => {
    const [p1, p2] = upconvertV1_0ToV1_1(LEGACY_V1_0_CONFIG).portlets as Record<string, unknown>[];
    // p1 (bare): title defaults to id; w/h/x/y:=0; query:={}; type preserved.
    expect(p1).toMatchObject({ id: "p1", type: "chart", title: "p1", w: 0, h: 0, x: 0, y: 0, query: {} });
    // p2 (had title+query+cubeId): those are PRESERVED; only w/h/x/y added.
    expect(p2).toMatchObject({
      id: "p2", type: "kpi", title: "Revenue", cubeId: "c1",
      query: { measures: ["x"] }, w: 0, h: 0, x: 0, y: 0,
    });
    // top-level layout preserved.
    expect((upconvertV1_0ToV1_1(LEGACY_V1_0_CONFIG) as { layout?: unknown }).layout).toEqual({ columns: 3, gap: 8 });
  });

  it("EMPTY-title corner: a title:'' portlet is VALID 1.0 but the bare wrap FAILS; up-convert coerces '' -> id (NULLIF)", () => {
    // The codex merge-safe corner: title:"" passes the permissive 1.0 schema
    // but FAILS the strict v1.1 title.min(1). A bare COALESCE(title,id) leaves
    // "" (only NULL is replaced); NULLIF(title,'') is required.
    const emptyTitleCfg = { portlets: [{ id: "pe", type: "chart", title: "" }] };
    expect(DashboardConfigV1Schema.safeParse(emptyTitleCfg).success).toBe(true);
    expect(DashboardConfigV1_1Schema.safeParse(emptyTitleCfg).success).toBe(false);
    // up-convert: the empty title is replaced by the (non-empty) id.
    const up = upconvertV1_0ToV1_1(emptyTitleCfg);
    expect((up.portlets as Record<string, unknown>[])[0].title).toBe("pe");
    expect(DashboardConfigV1_1Schema.safeParse(up).success).toBe(true);
    expect(registryErrors(wrapDcAsV12(up, "user"))).toEqual([]);
  });

  it("FIX: wrap(up-convert(pure-1.0.0 incl. an empty-title portlet)) PASSES the analytics registry validator (assertConfigV12)", () => {
    const env = wrapDcAsV12(upconvertV1_0ToV1_1(LEGACY_V1_0_CONFIG), "user");
    expect(registryErrors(env)).toEqual([]);
    // the 3rd (empty-title) portlet was coerced to its id.
    const dc = (env.portlets[0].config as { dashboard: { portlets: Record<string, unknown>[] } }).dashboard;
    expect(dc.portlets[2].title).toBe("p3");
  });

  it("a genuine grid (schema-1.1) body wraps to a registry-valid envelope without up-convert (1.1 path unchanged)", () => {
    expect(registryErrors(wrapDcAsV12(VALID_GRID_CONFIG, "team"))).toEqual([]);
  });

  it("the up-convert is a FIXED POINT: re-up-converting an already-up-converted body is identical (round-trip safe)", () => {
    const once = upconvertV1_0ToV1_1(LEGACY_V1_0_CONFIG);
    const twice = upconvertV1_0ToV1_1(once);
    expect(twice).toEqual(once);
  });
});

describe("core__0006 down(): single-portlet guard (cinatra#327 Finding 1)", () => {
  const dc = VALID_GRID_CONFIG;
  const analyticsPortlet = { instanceId: "analytics", kind: ANALYTICS_PORTLET_KIND, version: "1.0.0", slot: "fixed", config: { dashboard: dc } };
  const siblingPortlet = { instanceId: "ol", kind: "object-list", version: "1.0.0", slot: "optional", config: { typeId: "task" }, outputs: ["selectedId"] };
  const envelope = (portlets: unknown[], scopeLevel: string) => ({ apiVersion: V12, scopeLevel, portlets });

  it("MATCHES a genuine single-analytics-portlet migrated row (down() reverts it)", () => {
    expect(downGuardMatches({
      configVersion: V12, extensionId: null,
      configJson: envelope([analyticsPortlet], "user"),
    })).toBe(true);
  });

  it("FIX: does NOT match a NON-migrated MULTI-portlet operator row (analytics + sibling)", () => {
    // Producible via #326 reEnvelopeDcSave preserving siblings. Unwrapping it
    // would drop the sibling — the secondary finding. The single-portlet clause
    // must leave it untouched.
    expect(downGuardMatches({
      configVersion: V12, extensionId: null,
      configJson: envelope([analyticsPortlet, siblingPortlet], "team"),
    })).toBe(false);
  });

  it("does NOT match an extension row (extension_id guard)", () => {
    expect(downGuardMatches({
      configVersion: V12, extensionId: "@cinatra-ai/some-ext",
      configJson: envelope([analyticsPortlet], "organization"),
    })).toBe(false);
  });

  it("does NOT match an operator NON-analytics single-portlet row (kind guard)", () => {
    expect(downGuardMatches({
      configVersion: V12, extensionId: null,
      configJson: envelope([siblingPortlet], "user"),
    })).toBe(false);
  });

  it("does NOT match a legacy (non-envelope) row", () => {
    expect(downGuardMatches({ configVersion: "1.1.0", extensionId: null, configJson: dc })).toBe(false);
  });

  it("does NOT match an analytics-first multi-portlet row even with a SECOND analytics portlet", () => {
    // Two analytics portlets is still >1 portlet → untouched (no false unwrap).
    expect(downGuardMatches({
      configVersion: V12, extensionId: null,
      configJson: envelope([analyticsPortlet, { ...analyticsPortlet, instanceId: "analytics2" }], "user"),
    })).toBe(false);
  });

  it("sanity: the analytics kind predicate the guard relies on holds", () => {
    __resetPortletRegistryForTests();
    registerCorePortletKinds();
    expect(isAnalyticsPortletKind(ANALYTICS_PORTLET_KIND)).toBe(true);
    expect(getPortletKindDescriptor(ANALYTICS_PORTLET_KIND, "1.0.0")).toBeDefined();
  });
});
