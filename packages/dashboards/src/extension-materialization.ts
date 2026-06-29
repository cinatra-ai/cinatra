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

// Config-version constant + the embedded analytics body type. As of cinatra#329
// there is ONE dashboard format (apiVersion 1.2, validated by the registry
// validator above); the legacy 1.0.0/1.1.0 parse path + the #272 render-kind
// dispatcher were removed. `DashboardConfigV1_1` is the embedded drizzle-cube
// body an `analytics` portlet wraps. No writes — type/constant re-exports only.
export {
  CURRENT_CONFIG_VERSION,
  type DashboardConfigV1_1,
} from "./store/dashboard-config";

// The runtime-installer cube guard. The saga's preflight calls it against the
// materialized storeDir's dashboard config to reject an extension that references
// an unregistered cube (`reject`) or to register-runtime a package that declares
// host-allowlisted cube descriptors (`register-runtime`) BEFORE any write.
// Re-exported here (the stable extension-materialization subpath) so the host
// saga has one import surface; the guard's own logic is unchanged. The host cube
// catalog (`listRegisteredCubeNames`) stays on its own
// `@cinatra-ai/dashboards/cubes-platform` subpath — that module pulls the
// pg-backed cube singleton, which the saga loads lazily, not statically.
export {
  validateExtensionCubeUsage,
  PORTLET_CUBE_CONFIG_FIELDS,
  type DeclaredRuntimeCubeDescriptor,
  type ExtensionCubeUsageInput,
  type ExtensionCubeUsageOptions,
  type ExtensionCubeUsageVerdict,
} from "./extension/cube-guard";

// The typed-portlet registry the saga's preflight uses so the kind/version check
// runs WITH the real registry (closing the "validate-without-registry" gap)
// BEFORE the first write, mirroring `assertConfigV12`'s self-wire. The runtime
// portlet-kind installer symbols (cinatra#660) ride the same import surface.
export {
  getPortletKindDescriptor,
  getPortletKindDescriptorAnyVersion,
  registerRuntimePortletKind,
  unregisterRuntimePortletKind,
  unregisterRuntimePortletKindsForPackage,
  isRuntimePortletKind,
  type RuntimePortletKindRegistration,
  type RuntimePortletKindResult,
} from "./portlets/registry";
export {
  registerCorePortletKinds,
  hostBundledPortletKinds,
  PORTLET_KINDS_WITH_BUNDLED_COMPONENT,
  ANALYTICS_PORTLET_KIND,
  ANALYTICS_PORTLET_KIND_ALIAS,
} from "./portlets/kinds";
