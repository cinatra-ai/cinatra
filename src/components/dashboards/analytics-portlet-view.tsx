// App-side import boundary for the apiVersion 1.2 `analytics` portlet renderer
// (cinatra#325), reached by `<PortletHost>` for the `analytics` kind.
//
// The actual drizzle-cube grid mount lives inside the dashboards package
// (`packages/dashboards/src/components/analytics-portlet-view.tsx`) because the
// `drizzle-cube/client` import is only permitted there (ESLint Layer 4). This
// thin re-export keeps `<PortletHost>` (an app-dir client file that may NOT
// import drizzle-cube/client) referencing a stable app-local module it can
// `next/dynamic`-import behind the analytics branch. The dynamic import keeps
// the DC client bundle off non-analytics dashboards.
export {
  AnalyticsPortletView,
  type AnalyticsPortletViewProps,
} from "@cinatra-ai/dashboards/analytics-portlet-view";
