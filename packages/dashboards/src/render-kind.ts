// Renderer version-dispatch for the `/dashboards/[id]` route.
//
// Two structurally-incompatible dashboard config families coexist in the same
// `config_json` column, discriminated by the row's `config_version`:
//
//   - Legacy operator/agent family — semver `config_version` 1.0.0/1.1.0,
//     drizzle-cube portlets (id/title/w/h/x/y + analysisConfig|query). The shape
//     of EXISTING rows written before cinatra#326; new writes no longer produce
//     it (the create/save path now emits apiVersion 1.2). Migrated away by
//     cinatra#327. Schema: `store/dashboard-config.ts`.
//   - apiVersion 1.2 family — `config_version` literal apiVersion 1.2,
//     typed-portlet compositions keyed to the closed portlet registry. Produced
//     by the extension-install materializer AND (as of cinatra#326) by the
//     operator/agent create/save path, which wraps the drizzle-cube config in an
//     `analytics` portlet. Schema: `extension/dashboard-config-v12.ts`.
//
// The `[id]` renderer previously ran the apiVersion 1.2-only validator unconditionally and
// showed an "Unsupported dashboard format" card for everything else, so every
// agent-created (legacy 1.1.0) dashboard was rejected (cinatra#272). This helper
// is the pure dispatch the renderer uses to pick a render path WITHOUT importing
// any React/server-only code, so it is directly unit-testable.
import { parseDashboardConfig } from "./store/dashboard-config";
import {
  DASHBOARD_CONFIG_V12_VERSION,
  validateDashboardConfigV12,
} from "./extension/dashboard-config-v12";

/**
 * How the `/dashboards/[id]` route should render a given row.
 *
 *   - "v12"        → typed-portlet extension dashboard; render via `PortletHost`.
 *   - "legacy"     → operator/agent drizzle-cube dashboard; render via the
 *                    legacy grid (read-only).
 *   - "unsupported"→ neither family parses; show the "Unsupported dashboard
 *                    format" card.
 */
export type DashboardRenderKind = "v12" | "legacy" | "unsupported";

/** Legacy semver versions the drizzle-cube grid path can render. */
const LEGACY_CONFIG_VERSIONS = new Set(["1.0.0", "1.1.0"]);

/**
 * Resolve which render path a stored dashboard row uses.
 *
 * Dispatch is primarily on `configVersion` (the row's discriminator column),
 * with a defensive structural re-check so a corrupt/mislabeled row degrades to
 * "unsupported" rather than throwing inside the renderer:
 *
 *   - `config_version` equals the apiVersion 1.2 literal AND the payload
 *     validates structurally as apiVersion 1.2 → "v12".
 *   - `config_version` is a known legacy semver (1.0.0/1.1.0) AND the payload
 *     parses cleanly against that version's schema → "legacy". This mirrors the
 *     proven `/agents` screen path (`agents-dashboard.tsx`), which dispatches via
 *     `parseDashboardConfig(version, json)` and renders the drizzle-cube grid.
 *   - anything else (unknown version, or a payload that does not parse against
 *     the declared legacy version) → "unsupported".
 *
 * Note on 1.0.0 rows: the drizzle-cube grid consumes the 1.1 shape (w/h/x/y +
 * content spec). A 1.0.0 row that parses but lacks the grid's layout fields
 * renders DEGRADED (the grid tolerates missing layout — it does NOT crash),
 * which is the intended graceful fallback during migration: the goal is to STOP
 * the hard "Unsupported dashboard format" card for legacy rows, not to promise a
 * pixel-perfect layout for the rare/hypothetical pure-1.0.0 row. In practice the
 * create path always stamps 1.1.0, so 1.0.0 rows are legacy-only.
 *
 * Pure + side-effect free. No registry is passed to the apiVersion 1.2 validator (the
 * route renders typed portlets via the client registry, mirroring the existing
 * renderer behavior), so only the structural + wiring checks run here.
 */
export function resolveDashboardRenderKind(
  configVersion: string,
  configJson: unknown,
): DashboardRenderKind {
  if (configVersion === DASHBOARD_CONFIG_V12_VERSION) {
    return validateDashboardConfigV12(configJson).ok ? "v12" : "unsupported";
  }
  if (LEGACY_CONFIG_VERSIONS.has(configVersion)) {
    try {
      parseDashboardConfig(configVersion, configJson);
      return "legacy";
    } catch {
      return "unsupported";
    }
  }
  return "unsupported";
}
