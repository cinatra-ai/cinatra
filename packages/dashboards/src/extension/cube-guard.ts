// Cube-usage guard for runtime-installed extensions.
//
// Cubes (the semantic-layer FROM/JOIN sources behind chart portlets) register
// STATICALLY at boot — the fixed literal cube array in
// `cubes/platform-singleton.ts`. A runtime-installed extension therefore cannot
// add a new cube: doing so would require a process restart so the static
// registration runs again. This module is the PURE decision function the
// install pipeline calls to classify an extension's cube usage against the
// host's fixed cube catalog (obtained from `listRegisteredCubeNames()`).
//
// A portlet references a cube via a single string field in its opaque
// `config` blob, named either `cube` or `cubeRef` (the dashboard-config v1.2
// schema is `.strict()` and has no first-class cube field, so the reference
// lives inside `config`). When both are present, both are checked; a non-string
// value for either is ignored (the per-kind config validator owns shape checks).
//
// The `analytics` keystone kind (cinatra#325) is the EXCEPTION: it embeds a
// whole drizzle-cube dashboard at `config.dashboard`, so its cube references
// live inside `config.dashboard.portlets[].analysisConfig.query.*` (or a
// top-level `query`) as `"<cube>.<member>"` strings — NOT in a flat
// `cube`/`cubeRef` field. Without a kind-aware extractor an analytics portlet
// would silently pass the guard (no `cube`/`cubeRef` field → no refs → `"ok"`),
// an UNSAFE fail-open for extension-shipped analytics dashboards. The extractor
// below covers EVERY cube-bearing query surface drizzle-cube resolves a cube id
// from (`cubejs-wire.ts resolveCubeIdFromQuery`/`resolveAndValidateCubeId`):
// measures, dimensions, order keys, filters[].member, timeDimensions[].dimension
// AND segments — so a cube referenced solely through a filter or a segment is
// still caught.

import type { DashboardConfigV12, PortletConfigV12 } from "./dashboard-config-v12";
import { isAnalyticsPortletKind } from "../portlets/kinds";

/** Config field names a chart-portlet uses to reference a registered cube. */
export const PORTLET_CUBE_CONFIG_FIELDS = ["cube", "cubeRef"] as const;

/** Pull the `<cube>` prefix out of a fully-qualified `"<cube>.<member>"` ref. */
function cubePrefixOf(member: unknown): string | undefined {
  if (typeof member !== "string") return undefined;
  const dot = member.indexOf(".");
  return dot > 0 ? member.slice(0, dot) : undefined;
}

/** Collect cube prefixes from one drizzle-cube query object's member surfaces.
 *  Mirrors `cubejs-wire.ts` cube-id resolution: measures, dimensions, order
 *  keys, filters[].member, timeDimensions[].dimension, segments. */
function cubesFromQuery(query: unknown, into: Set<string>): void {
  if (typeof query !== "object" || query === null) return;
  const q = query as Record<string, unknown>;
  const pushAll = (arr: unknown) => {
    if (!Array.isArray(arr)) return;
    for (const m of arr) {
      const c = cubePrefixOf(m);
      if (c) into.add(c);
    }
  };
  pushAll(q.measures);
  pushAll(q.dimensions);
  pushAll(q.segments);
  if (q.order && typeof q.order === "object") {
    for (const key of Object.keys(q.order as Record<string, unknown>)) {
      const c = cubePrefixOf(key);
      if (c) into.add(c);
    }
  }
  if (Array.isArray(q.filters)) {
    for (const f of q.filters) {
      const c = cubePrefixOf((f as Record<string, unknown> | null)?.member);
      if (c) into.add(c);
    }
  }
  if (Array.isArray(q.timeDimensions)) {
    for (const td of q.timeDimensions) {
      const c = cubePrefixOf((td as Record<string, unknown> | null)?.dimension);
      if (c) into.add(c);
    }
  }
}

/** Cube refs of an `analytics`-kind portlet: walk the embedded drizzle-cube
 *  dashboard's portlets and collect every cube prefix referenced through any
 *  query surface. */
function analyticsCubeRefs(portlet: PortletConfigV12): string[] {
  const refs = new Set<string>();
  const dashboard = (portlet.config as Record<string, unknown> | undefined)?.dashboard;
  const dcPortlets = (dashboard as { portlets?: unknown } | null | undefined)?.portlets;
  if (!Array.isArray(dcPortlets)) return [];
  for (const dcPortlet of dcPortlets) {
    if (typeof dcPortlet !== "object" || dcPortlet === null) continue;
    const dp = dcPortlet as Record<string, unknown>;
    // DC portlets carry the query under analysisConfig.query (the canonical
    // shape) and/or a top-level `query` (legacy DC portlet field) — scan both.
    const analysisQuery = (dp.analysisConfig as { query?: unknown } | null | undefined)?.query;
    cubesFromQuery(analysisQuery, refs);
    cubesFromQuery(dp.query, refs);
  }
  return [...refs];
}

export type ExtensionCubeUsageInput = {
  /**
   * The extension's parsed dashboard config (v1.2). Optional — an extension
   * may ship without a dashboard. When present, every portlet's `config` is
   * scanned for `cube`/`cubeRef` references.
   */
  readonly dashboardConfig?: DashboardConfigV12 | null;
  /**
   * Cube names the extension package DECLARES it contributes (e.g. from a
   * `cinatra.dashboardCubes` manifest field). A non-empty list means the
   * package wants to register NEW cubes — impossible at runtime.
   */
  readonly declaredCubeContributions?: readonly string[] | null;
};

export type ExtensionCubeUsageOptions = {
  /** The host's fixed cube catalog (from `listRegisteredCubeNames()`). */
  readonly knownCubes: readonly string[];
};

export type ExtensionCubeUsageVerdict = {
  /**
   * - `"ok"`: the extension references only registered cubes (or none) and
   *   declares no cube contributions — safe to install at runtime.
   * - `"reject"`: a portlet references a cube NOT in the host catalog — the
   *   dashboard would render a broken chart; refuse the install.
   * - `"requires-rebuild"`: the extension declares cube contributions, which
   *   can only register via a static boot pass — defer to a rebuild/restart.
   */
  readonly verdict: "ok" | "reject" | "requires-rebuild";
  /** Human-readable explanation (present for non-`"ok"` verdicts). */
  readonly reason?: string;
  /** The offending cube names (present for `"reject"`/`"requires-rebuild"`). */
  readonly offendingCubes?: string[];
};

/** Extract the cube name(s) a single portlet references via config. */
function cubeRefsOf(portlet: PortletConfigV12): string[] {
  // analytics keystone (cinatra#325): refs live inside the embedded DC config,
  // not in a flat cube/cubeRef field — use the deep query extractor.
  if (isAnalyticsPortletKind(portlet.kind)) {
    return analyticsCubeRefs(portlet);
  }
  const refs: string[] = [];
  const config = portlet.config ?? {};
  for (const field of PORTLET_CUBE_CONFIG_FIELDS) {
    const value = (config as Record<string, unknown>)[field];
    if (typeof value === "string" && value.length > 0) refs.push(value);
  }
  return refs;
}

/**
 * Classify an extension's cube usage against the host's fixed cube catalog.
 *
 * Precedence: declared contributions are decided FIRST — a package that wants
 * to register new cubes is `"requires-rebuild"` regardless of how its portlets
 * reference cubes (the contribution itself, not the reference, is the blocker).
 * Otherwise, unknown cube references → `"reject"`; clean → `"ok"`.
 */
export function validateExtensionCubeUsage(
  input: ExtensionCubeUsageInput,
  options: ExtensionCubeUsageOptions,
): ExtensionCubeUsageVerdict {
  const known = new Set(options.knownCubes);

  // (a) Declared cube contributions can only register at static boot.
  const contributions = (input.declaredCubeContributions ?? []).filter(
    (c) => typeof c === "string" && c.length > 0,
  );
  if (contributions.length > 0) {
    return {
      verdict: "requires-rebuild",
      reason:
        "extension declares cube contributions, which register only at " +
        "static boot — a host rebuild/restart is required to add cubes",
      offendingCubes: [...new Set(contributions)],
    };
  }

  // (b) Portlet cube references must resolve to a registered cube.
  const unknownRefs = new Set<string>();
  for (const portlet of input.dashboardConfig?.portlets ?? []) {
    for (const ref of cubeRefsOf(portlet)) {
      if (!known.has(ref)) unknownRefs.add(ref);
    }
  }
  if (unknownRefs.size > 0) {
    const offendingCubes = [...unknownRefs];
    return {
      verdict: "reject",
      reason: `dashboard references unregistered cube(s): ${offendingCubes.join(", ")}`,
      offendingCubes,
    };
  }

  // (c) References only registered cubes (or none); no contributions.
  return { verdict: "ok" };
}
