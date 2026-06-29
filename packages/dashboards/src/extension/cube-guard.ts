// Cube-usage guard for runtime-installed extensions.
//
// Cubes (the semantic-layer FROM/JOIN sources behind chart portlets) are
// host-owned. As of cinatra#660 a runtime-installed extension MAY contribute a
// cube WITHOUT a rebuild — but ONLY as an ALIAS over a host FROM-allowlisted
// base cube with a member subset (the host owns all SQL + the tenant predicate;
// the extension supplies no SQL). This module is the PURE decision function the
// install pipeline calls to classify an extension's cube usage:
//   - declared runtime cube descriptors that ALL validate against the host
//     allowlist → `"register-runtime"` (register at runtime, no rebuild);
//   - a declared descriptor that fails allowlist validation → `"reject"`;
//   - a portlet referencing a cube neither in the host catalog nor declared by
//     this package → `"reject"`;
//   - otherwise → `"ok"`.
// The host catalog (bundled ∪ active-runtime) is passed in via `knownCubes`; the
// allowlist validator is injected via `validateDeclaredDescriptors`.
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

/**
 * A runtime cube descriptor the package declares (parsed from
 * `cinatra/cube-descriptors.json`). Validated by the injected
 * `validateDeclaredDescriptors` against the host FROM-allowlist + published
 * members. The host owns all SQL — the descriptor names only an alias id, an
 * allowlisted base table, and a member subset.
 */
export type DeclaredRuntimeCubeDescriptor = {
  readonly cubeId: string;
  readonly fromTable: string;
  readonly members: readonly string[];
};

export type ExtensionCubeUsageInput = {
  /**
   * The extension's parsed dashboard config (v1.2). Optional — an extension
   * may ship without a dashboard. When present, every portlet's `config` is
   * scanned for `cube`/`cubeRef` references.
   */
  readonly dashboardConfig?: DashboardConfigV12 | null;
  /**
   * The runtime cube descriptors the package DECLARES it contributes (parsed
   * from `cinatra/cube-descriptors.json`). When non-empty AND every descriptor
   * validates against the host allowlist, the verdict is `"register-runtime"`:
   * the cubes register at runtime (NO rebuild). A descriptor that fails
   * allowlist validation makes the whole install `"reject"` (it can never
   * register). The alias cube ids these declare are added to the known-cube set
   * so a portlet may reference the package's OWN new runtime cube.
   */
  readonly declaredCubeDescriptors?: readonly DeclaredRuntimeCubeDescriptor[] | null;
};

export type ExtensionCubeUsageOptions = {
  /** The host's current cube catalog (bundled ∪ active-runtime). */
  readonly knownCubes: readonly string[];
  /**
   * Validate the declared runtime cube descriptors against the host FROM-
   * allowlist + published members. Returns `{ ok: true }` when ALL validate, or
   * the first failure. Injected so the guard stays pure (no host catalog import).
   * Omitted ⇒ any declared descriptor is `"reject"` (fail-closed: the host has
   * no allowlist to validate against).
   */
  readonly validateDeclaredDescriptors?: (
    descriptors: readonly DeclaredRuntimeCubeDescriptor[],
  ) => { ok: true } | { ok: false; reason: string };
};

export type ExtensionCubeUsageVerdict = {
  /**
   * - `"ok"`: the extension references only registered cubes (or none) and
   *   declares no cube contributions — safe to install at runtime.
   * - `"register-runtime"`: the extension declares runtime cube descriptors that
   *   ALL validate against the host allowlist — register them at runtime (no
   *   rebuild). `registerCubeIds` carries the alias ids to register.
   * - `"reject"`: a portlet references a cube NOT in the host catalog (and not
   *   declared by this package), OR a declared descriptor fails allowlist
   *   validation — refuse the install.
   */
  readonly verdict: "ok" | "reject" | "register-runtime";
  /** Human-readable explanation (present for non-`"ok"` verdicts). */
  readonly reason?: string;
  /** The offending cube names (present for `"reject"`). */
  readonly offendingCubes?: string[];
  /** The alias cube ids to register (present for `"register-runtime"`). */
  readonly registerCubeIds?: string[];
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
 * Classify an extension's cube usage against the host's current cube catalog.
 *
 * Precedence: declared runtime cube descriptors are decided FIRST. A package
 * that declares descriptors which ALL validate against the host FROM-allowlist
 * is `"register-runtime"` (its cubes register at runtime, no rebuild). A
 * descriptor that fails allowlist validation makes the install `"reject"` (it
 * can never register). The alias ids a `register-runtime` package declares are
 * added to the known-cube set so the package's OWN portlets may reference them.
 * Otherwise, unknown portlet cube references → `"reject"`; clean → `"ok"`.
 */
export function validateExtensionCubeUsage(
  input: ExtensionCubeUsageInput,
  options: ExtensionCubeUsageOptions,
): ExtensionCubeUsageVerdict {
  const known = new Set(options.knownCubes);

  // (a) Declared runtime cube descriptors — validate against the host
  //     FROM-allowlist. ALL must validate or the install is rejected.
  const descriptors = (input.declaredCubeDescriptors ?? []).filter(
    (d): d is DeclaredRuntimeCubeDescriptor =>
      !!d && typeof d.cubeId === "string" && d.cubeId.length > 0,
  );
  let registerCubeIds: string[] = [];
  if (descriptors.length > 0) {
    const validate = options.validateDeclaredDescriptors;
    if (!validate) {
      // No host allowlist to validate against — fail closed.
      return {
        verdict: "reject",
        reason:
          "extension declares runtime cube descriptors but the host provided no " +
          "allowlist validator — refusing the install",
        offendingCubes: [...new Set(descriptors.map((d) => d.cubeId))],
      };
    }
    const result = validate(descriptors);
    if (!result.ok) {
      return {
        verdict: "reject",
        reason: `runtime cube descriptor rejected: ${result.reason}`,
        offendingCubes: [...new Set(descriptors.map((d) => d.cubeId))],
      };
    }
    registerCubeIds = [...new Set(descriptors.map((d) => d.cubeId))];
    // The package may reference its OWN newly-declared cubes from its portlets.
    for (const id of registerCubeIds) known.add(id);
  }

  // (b) Portlet cube references must resolve to a registered cube (bundled,
  //     active-runtime, OR one this package is registering now).
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

  // (c) Declared (valid) descriptors → register-runtime; else clean → ok.
  if (registerCubeIds.length > 0) {
    return { verdict: "register-runtime", registerCubeIds };
  }
  return { verdict: "ok" };
}
