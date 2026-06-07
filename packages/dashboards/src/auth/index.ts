// better-auth session -> SecurityContext binding (Cinatra glue,
// not sdk-dashboard).
// Async `buildSecurityContextWithAccessibleOrgIds` widens visibility
// across every org the caller belongs to.
export {
  buildSecurityContextFromIdentity,
  buildSecurityContextFromSession,
  buildSecurityContextWithAccessibleOrgIds,
  buildSecurityContextWithVisibility,
  type DashboardsIdentity,
  type DashboardsSessionLike,
  type AccessibleOrgIdsResolver,
  type VisibilityResolvers,
} from "./security-context";
export { DASHBOARD_VISIBILITY_RESOLVERS } from "./dashboard-visibility-resolvers";

// Project-scope dashboard access resolver (layers a project-grant
// gate on the 4-tier owner resolver).
export {
  requireDashboardAccess,
  filterReadableDashboards,
  DashboardAccessError,
  type DashboardAccessMode,
  type DashboardAuthzInput,
  type ProjectGrantLike,
} from "./require-dashboard-access";
export { resolveDashboardAccess, type DashboardActor, type DashboardAccess } from "../permissions";
