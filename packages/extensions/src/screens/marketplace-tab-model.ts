// ---------------------------------------------------------------------------
// Marketplace toolbar tab model (cinatra#1035 Slice E).
//
// PURE (no IO, no React) so the tab canonicalization is directly unit-testable
// — the client component (`extensions-marketplace-client.tsx`) is a thin
// consumer that renders MARKETPLACE_TABS and canonicalizes the `?tab=` query
// value through `resolveMarketplaceTab`.
//
// The workflow extension kind was removed (this issue), so its "Workflows" tab
// is gone. A stale/bookmarked `?tab=workflow` (or any other unknown value) must
// NOT 404 and must NOT leave a dead/empty tab selected: the route stays valid,
// the DEFAULT ("all") tab is selected, and the obsolete query value is stripped
// from the URL. This resolver is the single decision point; the client applies
// it identically for a direct load, a client-side navigation, and back/forward
// (its input is `useSearchParams().get("tab")`, which is reactive to all three).
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
 * Whether a raw `?tab=` query value is already canonical: absent (`null`) or one
 * of the rendered tab values. Anything else (the removed `"workflow"`, an empty
 * string, garbage) is stale and must be canonicalized away.
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
   * True when the raw query value is stale/unknown and the client must strip it
   * from the URL (canonicalize). False for the canonical values (absent, "all",
   * or one of the four kinds), so a legitimate tab is never rewritten.
   */
  stale: boolean;
};

/**
 * Canonicalize a raw `?tab=` value into the tab to select and whether the URL
 * must be rewritten to drop the value:
 *   - absent (`null`) or "all"      → the default All tab, canonical (no strip).
 *   - one of the four kind values   → that tab, canonical (no strip).
 *   - anything else (the removed     → the default All tab, STALE: the client
 *     "workflow", "", or garbage)      strips the obsolete param.
 */
export function resolveMarketplaceTab(raw: string | null): ResolvedMarketplaceTab {
  if (raw === null || raw === "all") {
    return { activeTab: "all", stale: false };
  }
  if (CANONICAL_TAB_VALUES.has(raw)) {
    return { activeTab: raw as MarketplaceTabValue, stale: false };
  }
  return { activeTab: "all", stale: true };
}
