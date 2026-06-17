// App-side import boundary for the legacy (config_version 1.0.0/1.1.0)
// dashboard renderer used by `/dashboards/[id]` (cinatra#272).
//
// The actual drizzle-cube grid mount lives inside the dashboards package
// (`packages/dashboards/src/components/legacy-dashboard-view.tsx`) because the
// `drizzle-cube/client` import is only permitted there (ESLint Layer 4). This
// thin re-export keeps the app's render path importing through a stable
// app-local module so the server route can `dynamic()`-import it behind the
// legacy branch, leaving the apiVersion 1.2 (PortletHost) path's client bundle untouched.
export {
  LegacyDashboardView,
  type LegacyDashboardViewProps,
} from "@cinatra-ai/dashboards/legacy-dashboard-view";
