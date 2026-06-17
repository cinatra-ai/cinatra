// Stable public subpath (`@cinatra-ai/dashboards/extension-materialization`) for
// the extension dashboard materializers. This file performs NO direct table
// writes — it only re-exports from the canonical `mutation-service.ts`, so the
// single-writer invariant (enforced by `__tests__/no-direct-writes.test.ts`)
// stays intact. Cross-package consumers (the workflows extension adapter) import
// from here rather than reaching into the mutation service directly.
export {
  materializeExtensionTemplate,
  materializeExtensionInstanceForProject,
  archiveExtensionDashboards,
  restoreExtensionDashboards,
  type MaterializeTemplateInput,
  type MaterializeInstanceInput,
  type ExtensionDashboardOwnerScope,
} from "./mutation-service";

export {
  validateDashboardConfigV12,
  dashboardConfigV12Schema,
  DASHBOARD_CONFIG_V12_VERSION,
  DASHBOARD_SCOPE_LEVELS,
  type DashboardConfigV12,
  type DashboardScopeLevel,
  type PortletKindLookup,
  type PortletKindDescriptor,
} from "./extension/dashboard-config-v12";

// Renderer version-dispatch (cinatra#272). Pure read-only helpers so the
// `/dashboards/[id]` route can pick a render path from the row's config_version
// instead of running the apiVersion 1.2-only validator unconditionally. No writes — these
// are structural validators only, so the single-writer invariant is untouched.
export {
  resolveDashboardRenderKind,
  type DashboardRenderKind,
} from "./render-kind";
export {
  parseDashboardConfig,
  isValidDashboardConfig,
  CURRENT_CONFIG_VERSION,
  type DashboardConfig,
  type DashboardConfigV1_1,
} from "./store/dashboard-config";

// The runtime-installer cube guard. The saga's preflight calls it against the
// materialized storeDir's dashboard config to reject an extension that references
// an unregistered cube (`reject`) or declares new cube contributions
// (`requires-rebuild`) BEFORE any write. Re-exported here (the stable
// extension-materialization subpath) so the host saga has one import surface; the
// guard's own logic is unchanged. The host cube catalog (`listRegisteredCubeNames`)
// stays on its own `@cinatra-ai/dashboards/cubes-platform` subpath — that module
// pulls the pg-backed cube singleton, which the saga loads lazily, not statically.
export {
  validateExtensionCubeUsage,
  PORTLET_CUBE_CONFIG_FIELDS,
  type ExtensionCubeUsageInput,
  type ExtensionCubeUsageOptions,
  type ExtensionCubeUsageVerdict,
} from "./extension/cube-guard";

// The typed-portlet registry the saga's preflight uses so the kind/version check
// runs WITH the real registry (closing the "validate-without-registry" gap)
// BEFORE the first write, mirroring `assertConfigV12`'s self-wire.
export { getPortletKindDescriptor } from "./portlets/registry";
export { registerCorePortletKinds } from "./portlets/kinds";
