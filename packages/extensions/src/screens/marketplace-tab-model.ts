// ---------------------------------------------------------------------------
// Marketplace toolbar tab model (cinatra#1035 Slice E).
//
// PURE (no IO, no React) so the tab canonicalization is directly unit-testable
// — the client component (`extensions-marketplace-client.tsx`) is a thin
// consumer that renders MARKETPLACE_TABS and canonicalizes the `?tab=` query
// value through `resolveMarketplaceTab`.
//
// The workflow extension kind was removed (this issue), so its "Workflows" tab
// is gone. A stale/bookmarked `?tab=workflow` (the removed kind) must NOT 404
// and must NOT leave a dead/empty tab selected: it resolves to the DEFAULT
// ("all") tab and the client strips the obsolete value from the URL.
//
// SCOPE — the grid strips ONLY a value it historically owned: a REMOVED
// marketplace tab value ("workflow"). A foreign value the grid never owned is
// resolved to "all" but LEFT in the URL, so the grid never clobbers another
// surface's param. This matters because the `?tab=` query key is co-tenanted:
// the design-conformance seeded harness mounts this grid AND the
// installed-extensions status filter (which owns `?tab=archived`) on one route.
// A blanket "strip every unknown value" would rewrite the installed filter's
// `?tab=archived` out from under it (cinatra#1645 tab-select navigation).
//
// This resolver is the single decision point; the client applies it identically
// for a direct load, a client-side navigation, and back/forward (its input is
// `useSearchParams().get("tab")`, which is reactive to all three).
// ---------------------------------------------------------------------------

/**
 * The marketplace filter tabs — "All" plus the four extension kinds
 * (agent | connector | artifact | skill). Single source of truth for both the
 * rendered toolbar and the set of canonical `?tab=` values. Ordered as the
 * toolbar renders them.
 */
export const MARKETPLACE_TABS = [
  { value: "all", label: "All" },
  { value: "agent", label: "Agents" },
  { value: "skill", label: "Skills" },
  { value: "connector", label: "Connectors" },
  { value: "artifact", label: "Artifacts" },
] as const;

export type MarketplaceTabValue = (typeof MARKETPLACE_TABS)[number]["value"];

const CANONICAL_TAB_VALUES: ReadonlySet<string> = new Set(
  MARKETPLACE_TABS.map((t) => t.value),
);

/**
 * Marketplace tab values that WERE rendered tabs and have since been retired.
 * A stale/bookmarked `?tab=<removed>` resolves to the default "all" tab AND is
 * stripped from the URL (never a 404, never a dead tab). cinatra#1035 retired
 * the "workflow" kind. Intentionally narrow — ONLY the grid's own former values,
 * so a foreign value the grid never owned (e.g. the installed filter's
 * "archived") is never mistaken for something to strip.
 */
const REMOVED_TAB_VALUES: ReadonlySet<string> = new Set(["workflow"]);

/**
 * Whether a raw `?tab=` query value is one of the rendered canonical tab values:
 * absent (`null`) or one of All / the four kinds. Distinct from the strip
 * decision (`resolveMarketplaceTab().stale`), which fires only for a REMOVED
 * marketplace value — a non-canonical value is not automatically stripped.
 */
export function isCanonicalTabValue(raw: string | null): boolean {
  return raw === null || CANONICAL_TAB_VALUES.has(raw);
}

export type ResolvedMarketplaceTab = {
  /**
   * The tab to render/filter by. A stale/unknown value resolves to the default
   * ("all") tab — never a dead tab, never a 404.
   */
  activeTab: MarketplaceTabValue;
  /**
   * True ONLY when the raw value is a REMOVED marketplace tab value (the retired
   * "workflow") the client must strip from the URL. False for the canonical
   * values (absent, "all", or one of the four kinds) AND for any foreign value
   * the grid never owned (e.g. the installed filter's "archived", or garbage) —
   * so the grid never rewrites a legitimate tab nor clobbers a co-mounted
   * surface's `?tab=` param.
   */
  stale: boolean;
};

/**
 * Canonicalize a raw `?tab=` value into the tab to render and whether the client
 * must rewrite the URL to drop the value:
 *   - absent (`null`) or "all"      → the default All tab, canonical (no strip).
 *   - one of the four kind values   → that tab, canonical (no strip).
 *   - a REMOVED marketplace value   → the default All tab, STALE: the client
 *     (the retired "workflow")         strips the obsolete param.
 *   - any other foreign/unknown     → the default All tab, NOT stale (left as-is).
 *     value (the installed filter's    The grid never owned this value, so it
 *     "archived", "", garbage)         must not clobber it — a co-mounted surface
 *                                      may own the shared `?tab=` key. Rendering
 *                                      "all" is the correct default; stripping is
 *                                      not the grid's call.
 */
export function resolveMarketplaceTab(raw: string | null): ResolvedMarketplaceTab {
  if (raw === null || raw === "all") {
    return { activeTab: "all", stale: false };
  }
  if (CANONICAL_TAB_VALUES.has(raw)) {
    return { activeTab: raw as MarketplaceTabValue, stale: false };
  }
  // A removed marketplace tab value (workflow) is canonicalized away; any other
  // foreign value renders "all" but is LEFT in the URL — not the grid's to strip.
  return { activeTab: "all", stale: REMOVED_TAB_VALUES.has(raw) };
}
