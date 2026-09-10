// /agents tab-bar model (cinatra#1007).
//
// /agents was restructured into two tabs:
//   - "All Agents" (default) — the run-agent picker, now served AT /agents
//     (moved from the old /agents/run, which is removed/replaced — not
//     redirected; old deep links to /agents/run intentionally 404).
//   - "Executions" — the top-5-recently-used + 5-latest-run dashboard, moved
//     from the old /agents to /agents/executions.
//
// One shared list drives both AgentsTabNav render sites (the picker in
// packages/agents/src/pages.tsx and the dashboard in
// packages/dashboards/src/screens/agents-dashboard.tsx) so the tab labels/
// hrefs/order cannot drift between the two routes.
export type AgentsTabValue = "all" | "executions" | "reviews";

export type AgentsNavItem = {
  /** Stable key for the active-tab state. */
  value: AgentsTabValue;
  label: string;
  href: string;
};

export const AGENTS_NAV: readonly AgentsNavItem[] = [
  { value: "all", label: "All Agents", href: "/agents" },
  { value: "executions", label: "Executions", href: "/agents/executions" },
  // "Reviews" — the org's open artifact-review queue (cinatra#2047 row 9). It
  // belongs on this bar rather than in Configuration because it is a REVIEWER's
  // working surface, not an administrator's: a plain org member both sees it and
  // decides on it. The counts are org-wide; the listed rows are filtered by run
  // access on the page itself.
  { value: "reviews", label: "Reviews", href: "/agents/reviews" },
] as const satisfies readonly AgentsNavItem[];

// THE BAR NEVER ESCAPES THE SCOPE IT IS DRAWN IN (cinatra#2809, S3).
//
// `AGENTS_NAV` addresses the ROOT Agents surface, and on a scoped Agents tab
// every one of its three hrefs would walk the reader out of the organization,
// team or project they are looking at — silently, because the tab labels read
// the same in both places. So a scoped render asks for the scoped bar instead,
// and the root-escape test pins that not one href leaves the base.
//
// Labels, keys and order are scope-invariant: the bar is the SAME bar, drawn at
// another vantage.

/** A scope base is a rooted path with no trailing slash and no empty segment —
 *  a malformed one would mint `//agents`, which is another host. */
function assertScopeBase(base: string): string {
  if (!/^(?:\/[^/\s\\]+)+$/.test(base)) {
    throw new Error(`agents-nav: invalid scope base ${JSON.stringify(base)}`);
  }
  return base;
}

/** The tab bar for a scope — the bare `AGENTS_NAV` when there is no base. */
export function agentsNavFor(scopeBase?: string | null): readonly AgentsNavItem[] {
  if (scopeBase == null) return AGENTS_NAV;
  const base = assertScopeBase(scopeBase);
  return Object.freeze(
    AGENTS_NAV.map((item) => Object.freeze({ ...item, href: `${base}${item.href}` })),
  );
}
