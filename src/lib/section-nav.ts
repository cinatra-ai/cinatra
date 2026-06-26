// Single source of truth for tabbed-section navigation (#493). Both the in-page
// content tabs (e.g. MetricApiNav) and the sidebar sub-items (app-sidebar) render
// from the SAME list, so their labels and targets can't drift apart. Reusable
// for any tabbed section: define one SectionNavItem[] and feed it to both
// surfaces (sidebar sub-items via { title: label, url: href }).
export type SectionNavItem = {
  /** Stable key for the active-tab state. */
  value: string;
  /** One label vocabulary shared by the tab and the sidebar entry. */
  label: string;
  href: string;
};

// Analytics: Costs | Usage | API Requests. "Usage" was previously reachable only
// via the content tabs (it was missing from the sidebar), and the two surfaces
// used different labels ("LLM"/"API"); sourcing both from here fixes the gap and
// unifies the vocabulary.
export const ANALYTICS_NAV = [
  { value: "costs", label: "Costs", href: "/analytics/llm" },
  { value: "usage", label: "Usage", href: "/analytics/llm-usage" },
  { value: "traces", label: "API Requests", href: "/analytics/api" },
] as const satisfies readonly SectionNavItem[];

export type AnalyticsTabValue = (typeof ANALYTICS_NAV)[number]["value"];
