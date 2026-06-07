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

import type { DashboardConfigV12, PortletConfigV12 } from "./dashboard-config-v12";

/** Config field names a chart-portlet uses to reference a registered cube. */
export const PORTLET_CUBE_CONFIG_FIELDS = ["cube", "cubeRef"] as const;

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
