// Tabbed-section navigation model. Analytics has TWO levels (#617):
//
//   Level 1 — CATEGORY (sidebar sub-item + constant context heading). The
//     sidebar `Analytics >` group lists categories; for now exactly one: LLM.
//     The category name is also the page heading and does NOT change when
//     switching tabs.
//   Level 2 — VIEW/TAB (in-page tabs within a category, e.g. MetricApiNav).
//     The LLM category's tabs are Costs | Usage | API Requests; the per-tab
//     description is what changes below the constant heading.
//
// #493 unified the tabs + sidebar into one list to kill an orphaned-tab /
// label-drift bug. #617 keeps that single-vocabulary win for the TABS but
// un-couples the sidebar from the tab list so the sidebar represents
// categories (future: Websites, Social Media, KPIs, …), each with its own tabs.
export type SectionNavItem = {
  /** Stable key for the active-tab state. */
  value: string;
  /** One label vocabulary shared by the tab and (where applicable) other surfaces. */
  label: string;
  href: string;
  /**
   * Short one-line description shown below the (constant) category heading on
   * the tab's page. The heading stays the category name; the description is
   * what changes per tab.
   */
  description: string;
};

// LLM category tabs: Costs | Usage | API Requests. "Usage" was previously
// reachable only via the content tabs; #493 surfaced it and unified the
// vocabulary. These now feed MetricApiNav and the per-page descriptions ONLY —
// the sidebar is sourced from ANALYTICS_CATEGORIES (#617), not from here.
export const ANALYTICS_NAV = [
  {
    value: "costs",
    label: "Costs",
    href: "/analytics/llm",
    description: "LLM spend broken down by model, agent, and time period.",
  },
  {
    value: "usage",
    label: "Usage",
    href: "/analytics/llm-usage",
    description: "Token and request volume across models and agents over time.",
  },
  {
    value: "traces",
    label: "API Requests",
    href: "/analytics/api",
    description:
      "API request traces and span-level execution visibility for agents",
  },
] as const satisfies readonly SectionNavItem[];

export type AnalyticsTabValue = (typeof ANALYTICS_NAV)[number]["value"];

/** Look up a tab's description by value (heading stays the category name). */
export function analyticsTabDescription(value: AnalyticsTabValue): string {
  return ANALYTICS_NAV.find((t) => t.value === value)!.description;
}

// ───── Analytics categories (sidebar Level 1) ─────

export type AnalyticsCategory = {
  /** Stable key for the category. */
  key: string;
  /** Category name — sidebar entry AND the constant page heading. */
  label: string;
  /** Landing route for the category (its first / default tab). */
  href: string;
};

// Sidebar `Analytics >` lists CATEGORIES. For now exactly one: LLM. The label
// doubles as the constant page heading for every tab in the category. Future
// categories (Websites, Social Media, KPIs) get added here — each with its own
// tab list — without forcing every tab into the sidebar.
export const ANALYTICS_CATEGORIES = [
  { key: "llm", label: "LLM", href: "/analytics/llm" },
] as const satisfies readonly AnalyticsCategory[];

// The routes the LLM category owns — every tab in ANALYTICS_NAV. Derived from
// the tab list so it can't drift. Used to mark the LLM sidebar entry active
// across ALL of its tabs (Costs / Usage / API Requests) plus their nested
// sub-routes (e.g. /analytics/llm/pricing), honoring the #581 active-state
// caveat for nested routes under /analytics/llm*.
export const ANALYTICS_CATEGORY_PATHS: Readonly<Record<string, readonly string[]>> = {
  llm: ANALYTICS_NAV.map((t) => t.href),
};
