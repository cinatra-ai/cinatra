// shadcn-built portlet primitives (Portlet, KPI, List, Chart, Table) land
// alongside the /agents dashboard.
//
// THE PROMOTED READ-ONLY COMPOSITIONS (enabler 0.11 of
// `PLAN: Agents Lifecycle (C)`, cinatra#3027) are exported from here: this
// subpath IS the SDK surface the extension boundary admits
// (`@cinatra-ai/sdk-extensions/read-only-compositions`), and the host's own
// read-only dashboard surfaces import the same two components from it.
export {
  narrowToSinglePortlet,
  type NarrowableDashboardConfig,
} from "./narrow-to-single-portlet";
export {
  ReadOnlyComposedDashboard,
  ReadOnlySinglePortlet,
  type ReadOnlyComposedDashboardProps,
  type ReadOnlySinglePortletProps,
} from "./read-only-composition";
