// Registration of the generic portlet KIND metadata: the 9 generic kinds plus
// the keystone `analytics` kind (and its `cube-dashboard` alias, cinatra#325).
// METADATA ONLY (scopePolicy, input/output keys, install-time validateConfig) —
// server-safe, imported by the dashboard install validator. The interactive
// client components are resolved separately by the client PortletHost
// (portlet-host.tsx).
//
// Key-naming convention: kinds declare GENERIC input/output keys (e.g.
// object-list emits "selectedId"); dashboard.json instances wire via
// { fromInstanceId, key } using these generic keys, distinguished by
// instanceId — NOT instance-specific output names. Launcher kinds set
// allowsArbitraryInputs (dynamic prefill keys).
import { collectQueryCubeIds, describeCrossCubeQuery } from "@cinatra-ai/sdk-dashboard";

import { registerPortletKind, type PortletConfigError, type PortletInstanceForValidation } from "./registry";
import { DashboardConfigV1_1Schema } from "../store/dashboard-config";

const PORTLET_VERSION = "1.0.0";

/** Version stamped on the analytics portlet a wrapped operator/agent dashboard
 *  carries (cinatra#326 wrap path). Exported so the apiVersion 1.2 envelope
 *  helper stamps the SAME version the kind is registered under — no drift. */
export const ANALYTICS_PORTLET_VERSION = PORTLET_VERSION;

/** The kind name for the keystone analytics portlet (cinatra#325) and its alias.
 *  Both names register identical metadata so either validates. The portlet wraps
 *  a WHOLE drizzle-cube DashboardConfig as one embedded view at
 *  `config.dashboard` (NOT one portlet per chart) — see the apiVersion 1.2 design §1. */
export const ANALYTICS_PORTLET_KIND = "analytics" as const;
export const ANALYTICS_PORTLET_KIND_ALIAS = "cube-dashboard" as const;
export const ANALYTICS_PORTLET_KINDS = [
  ANALYTICS_PORTLET_KIND,
  ANALYTICS_PORTLET_KIND_ALIAS,
] as const;

/** True when a portlet kind is the embedded-analytics (drizzle-cube) kind. */
export function isAnalyticsPortletKind(kind: string): boolean {
  return kind === ANALYTICS_PORTLET_KIND || kind === ANALYTICS_PORTLET_KIND_ALIAS;
}

/**
 * The portlet kinds for which the host bundles a CLIENT component (the keys of
 * `COMPONENT_MAP` in `src/components/dashboards/portlet-host.tsx`, plus the
 * `analytics`/`cube-dashboard` keystone kinds rendered by the embedded grid).
 * Server-safe (no React import) so the runtime portlet-kind installer can gate
 * `rendersAs` against the set of kinds that actually have a component WITHOUT
 * importing the `"use client"` host. A parity test
 * (`portlet-component-parity.test.ts`) asserts this list equals the live
 * COMPONENT_MAP keys ∪ analytics aliases.
 */
export const PORTLET_KINDS_WITH_BUNDLED_COMPONENT = [
  "object-list",
  "object-detail",
  "artifact-list",
  "artifact-version-history",
  "artifact-edit-text",
  "artifact-edit-binary-prompt",
  "agent-launcher",
  ANALYTICS_PORTLET_KIND,
  ANALYTICS_PORTLET_KIND_ALIAS,
] as const;

/** A fresh array of the kinds that have a bundled client component. */
export function hostBundledPortletKinds(): string[] {
  return [...PORTLET_KINDS_WITH_BUNDLED_COMPONENT];
}

/**
 * The single-query cube-scope check (cinatra#1512): a drizzle-cube portlet's
 * executable single query must reference exactly one cube — the query
 * endpoint rejects mixed-cube queries with `cube_id_ambiguous`, so letting one
 * persist yields a portlet that can never render (the AnalysisBuilder editor
 * happily emits one, and its KPI preview only queries the yAxis measure, so
 * the mix isn't caught client-side). Enumerates the query object(s) the
 * embedded portlet would actually EXECUTE:
 *   - `analysisConfig` present → only its `query`, and only for the "query"
 *     analysis type (funnel/flow/retention carry different query DSLs the v1
 *     endpoint rejects wholesale as `unsupported_analysis_type`);
 *   - otherwise the legacy top-level `query` field (object, or the legacy DC
 *     JSON-string form) — mirroring drizzle-cube's `ensureAnalysisConfig`
 *     precedence.
 * A multi-query config (`queries[]` — the explicitly-supported multi-query
 * mode) is checked PER SUB-QUERY: each sub-query hits /load (or a /batch item)
 * individually and must itself be single-cube; spanning cubes ACROSS
 * sub-queries stays allowed.
 */
function embeddedExecutableQueries(dcPortlet: Record<string, unknown>): unknown[] {
  const out: unknown[] = [];
  const pushQueryOrMulti = (q: unknown): void => {
    if (typeof q !== "object" || q === null) return;
    const queries = (q as Record<string, unknown>).queries;
    if (Array.isArray(queries)) {
      for (const sub of queries) {
        if (typeof sub === "object" && sub !== null) out.push(sub);
      }
      return;
    }
    out.push(q);
  };
  const ac = dcPortlet.analysisConfig;
  if (typeof ac === "object" && ac !== null) {
    const analysis = ac as Record<string, unknown>;
    if (analysis.analysisType === undefined || analysis.analysisType === "query") {
      pushQueryOrMulti(analysis.query);
    }
    return out;
  }
  const legacy = dcPortlet.query;
  if (typeof legacy === "string") {
    // Legacy DC portlets persist the query as a JSON string; an unparseable
    // string is left to drizzle-cube's own invalid-JSON handling.
    try {
      pushQueryOrMulti(JSON.parse(legacy));
    } catch {
      /* not JSON — nothing to check */
    }
  } else {
    pushQueryOrMulti(legacy);
  }
  return out;
}

/**
 * The chart type an embedded DC portlet renders with — `charts[analysisType]
 * .chartType` when an `analysisConfig` is present (the shape PortletContainer
 * reads), else the legacy top-level `chartType`. Undefined when neither is a
 * string.
 */
function embeddedChartType(dcPortlet: Record<string, unknown>): string | undefined {
  const ac = dcPortlet.analysisConfig;
  if (typeof ac === "object" && ac !== null) {
    const analysis = ac as Record<string, unknown>;
    const analysisType =
      typeof analysis.analysisType === "string" ? analysis.analysisType : "query";
    const charts = analysis.charts;
    const mode =
      typeof charts === "object" && charts !== null
        ? (charts as Record<string, unknown>)[analysisType]
        : undefined;
    const chartType =
      typeof mode === "object" && mode !== null
        ? (mode as Record<string, unknown>).chartType
        : undefined;
    return typeof chartType === "string" ? chartType : undefined;
  }
  return typeof dcPortlet.chartType === "string" ? dcPortlet.chartType : undefined;
}

/** Install-time validation for the analytics kind: `config.dashboard` must be a
 *  structurally-valid drizzle-cube DashboardConfig (the 1.1 shape, which is the
 *  embedded format). The 1.1 schema is `.passthrough()`, so future DC fields are
 *  tolerated; deep chart semantics stay DC-owned (mirrors how 1.1 keeps
 *  `analysisConfig` opaque). Codex round-0: tightened from a loose "object with
 *  portlets array" to the real 1.1 schema so a malformed embedded config fails
 *  closed at materialization.
 *
 *  On top of the structural parse, each embedded portlet's executable single
 *  queries must be cube-scoped (cinatra#1512) — see
 *  `embeddedExecutableQueries`. This runs ONLY on the write path (every save
 *  funnels through the mutation service's registry validation); the READ path
 *  (`readDcConfigFromRow`) deliberately keeps the plain 1.1 schema so a
 *  pre-existing row with a mixed-cube portlet still renders (with the
 *  endpoint's human-readable error card) instead of being swapped for the
 *  empty seed. */
function validateAnalyticsPortletConfig(p: PortletInstanceForValidation): PortletConfigError[] {
  const dashboard = p.config.dashboard;
  if (typeof dashboard !== "object" || dashboard === null) {
    return [{ code: "port_analytics_missing_dashboard", message: "config.dashboard (the embedded drizzle-cube dashboard config) is required" }];
  }
  const res = DashboardConfigV1_1Schema.safeParse(dashboard);
  if (!res.success) {
    return [
      {
        code: "port_analytics_invalid_dashboard",
        message: `config.dashboard is not a valid analytics dashboard: ${res.error.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ")}`,
      },
    ];
  }
  const errors: PortletConfigError[] = [];
  for (const dcPortlet of res.data.portlets) {
    const dp = dcPortlet as Record<string, unknown>;
    const queries = embeddedExecutableQueries(dp);
    const chartType = embeddedChartType(dp);
    // KPI charts (kpiNumber/kpiDelta/kpiText) render ONE value from ONE data
    // source, so the whole portlet — across ALL sub-queries of a multi-query
    // config — must stay on a single cube (issue #1512 acceptance: "constrain
    // selectable measures to one cube or create separate KPI portlets per
    // cube"). Other chart types only need each individual query to be
    // single-cube; a multi-query config may span cubes ACROSS sub-queries.
    const isKpiChart = typeof chartType === "string" && chartType.startsWith("kpi");
    if (isKpiChart) {
      const union: string[] = [];
      const seen = new Set<string>();
      for (const query of queries) {
        for (const cubeId of collectQueryCubeIds(query)) {
          if (!seen.has(cubeId)) {
            seen.add(cubeId);
            union.push(cubeId);
          }
        }
      }
      if (union.length > 1) {
        errors.push({
          code: "port_analytics_cross_cube_query",
          message: `card "${dcPortlet.title}": ${describeCrossCubeQuery(union)} A KPI reads from a single data source — create a separate KPI card per data source instead.`,
        });
      }
    } else {
      for (const query of queries) {
        const cubeIds = collectQueryCubeIds(query);
        if (cubeIds.length > 1) {
          errors.push({
            code: "port_analytics_cross_cube_query",
            message: `card "${dcPortlet.title}": ${describeCrossCubeQuery(cubeIds)}`,
          });
        }
      }
    }
  }
  return errors;
}

function reqConfigString(portlet: PortletInstanceForValidation, key: string, code: string): PortletConfigError[] {
  return typeof portlet.config[key] === "string" && (portlet.config[key] as string).length > 0
    ? []
    : [{ code, message: `portlet config.${key} is required` }];
}

export function registerCorePortletKinds(): void {
  // object-list — list cinatra.objects by config typeId + query.
  registerPortletKind({
    kind: "object-list",
    version: PORTLET_VERSION,
    scopePolicy: { scopeFrom: "session", resource: "object", op: "object.read" },
    inputKeys: ["parentId"],
    outputKeys: ["selectedId"],
    validateConfig: (p) => reqConfigString(p, "typeId", "port_object_list_missing_type"),
  });

  // object-detail — read-only detail for the selected object id.
  registerPortletKind({
    kind: "object-detail",
    version: PORTLET_VERSION,
    scopePolicy: { scopeFrom: "session", resource: "object", op: "object.read" },
    inputKeys: ["objectId"],
    outputKeys: [],
  });

  // artifact-list — list artifact rows by config extensionPackageName.
  registerPortletKind({
    kind: "artifact-list",
    version: PORTLET_VERSION,
    scopePolicy: { scopeFrom: "session", resource: "artifact", op: "object.read" },
    inputKeys: [],
    outputKeys: ["selectedArtifactId"],
    validateConfig: (p) => reqConfigString(p, "extensionPackageName", "port_artifact_list_missing_extension"),
  });

  // artifact-edit-text — ref-swap inline text edit on a parent object.
  registerPortletKind({
    kind: "artifact-edit-text",
    version: PORTLET_VERSION,
    scopePolicy: { scopeFrom: "session", resource: "artifact", op: "object.update" },
    inputKeys: ["parentObjectId"],
    outputKeys: [],
    validateConfig: (p) => [
      ...reqConfigString(p, "refSwapPrimitive", "port_edit_text_missing_refswap"),
      ...reqConfigString(p, "parentObjectField", "port_edit_text_missing_refswap"),
    ],
  });

  // artifact-edit-binary-prompt — prompt-driven binary regen (auto/manual).
  registerPortletKind({
    kind: "artifact-edit-binary-prompt",
    version: PORTLET_VERSION,
    scopePolicy: { scopeFrom: "session", resource: "artifact", op: "object.update" },
    inputKeys: ["parentObjectId"],
    outputKeys: [],
    validateConfig: (p) => {
      const errs: PortletConfigError[] = [
        ...reqConfigString(p, "generationPrimitive", "port_edit_binary_invalid_config"),
        ...reqConfigString(p, "parentObjectField", "port_edit_binary_invalid_config"),
      ];
      const mode = p.config.refSwapMode;
      if (mode !== "auto" && mode !== "manual") {
        errs.push({ code: "port_edit_binary_invalid_config", message: 'config.refSwapMode must be "auto" | "manual"' });
      } else if (mode === "manual" && typeof p.config.refSwapPrimitive !== "string") {
        errs.push({ code: "port_edit_binary_invalid_config", message: "config.refSwapPrimitive is required when refSwapMode is manual" });
      } else if (mode === "auto" && p.config.refSwapPrimitive !== undefined) {
        errs.push({ code: "port_edit_binary_invalid_config", message: "config.refSwapPrimitive must be absent when refSwapMode is auto" });
      }
      return errs;
    },
  });

  // artifact-version-history — parent object's ref-swap timeline.
  registerPortletKind({
    kind: "artifact-version-history",
    version: PORTLET_VERSION,
    scopePolicy: { scopeFrom: "session", resource: "object", op: "object.read" },
    inputKeys: ["parentObjectId"],
    outputKeys: [],
    validateConfig: (p) => reqConfigString(p, "parentObjectField", "port_version_history_missing_field"),
  });

  // agent-launcher — wraps agent_run start (dynamic prefills).
  registerPortletKind({
    kind: "agent-launcher",
    version: PORTLET_VERSION,
    scopePolicy: { scopeFrom: "session", resource: "none" },
    inputKeys: [],
    outputKeys: ["runId"],
    allowsArbitraryInputs: true,
    validateConfig: (p) =>
      typeof p.config.agentRef === "string" || typeof p.config.agentPackage === "string"
        ? []
        : [{ code: "port_agent_launcher_missing_agent", message: "config.agentRef or config.agentPackage is required" }],
  });

  // analytics (keystone, cinatra#325) — embeds a WHOLE drizzle-cube
  // DashboardConfig at `config.dashboard` and renders the full interactive grid
  // (charts/filters/save/drag-resize) via PortletHost → embedded-drizzle-cube-dashboard-grid.
  // Self-contained: no inputs/outputs (the cube SQL predicate owns tenant
  // isolation, so the scopePolicy carries no op — like the launcher kinds that
  // delegate authz to the wrapped primitive). Registered under both the
  // canonical name and the `cube-dashboard` alias.
  for (const kind of ANALYTICS_PORTLET_KINDS) {
    registerPortletKind({
      kind,
      version: PORTLET_VERSION,
      scopePolicy: { scopeFrom: "session", resource: "dashboard" },
      inputKeys: [],
      outputKeys: [],
      validateConfig: validateAnalyticsPortletConfig,
    });
  }
}
