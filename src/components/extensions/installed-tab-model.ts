// ---------------------------------------------------------------------------
// Installed-extensions status-filter tab model (cinatra#1571).
//
// PURE (no IO, no React, no "use client") so the URL `?tab=` contract is
// directly unit-testable and shared by every consumer without duplication:
//   - the client control (extensions-tab-select.tsx) renders INSTALLED_TABS and
//     pushes the `?tab=` URL on selection;
//   - the server screen (registry-catalog-screen.tsx) and the seeded
//     design-conformance harness both narrow the raw `?tab=` value through
//     `resolveInstalledTab` to pick the partition to render.
//
// The four status views (cinatra#1571): "All" (any status together), "Active"
// (status === "active"), "Locked" (status === "locked" — a view these system /
// required-in-prod extensions never had before), "Archived" (status ===
// "archived"). The status views are a clean PARTITION of the installed set —
// every row falls in exactly ONE of Active / Locked / Archived, and "All" is
// their union — so no row is dropped or double-counted across the views
// (cinatra#1571 AC5).
//
// URL contract (cinatra#1571 AC2 — observable, not implicit):
//   - absent / no-query (`undefined`|`null`) → the DEFAULT "active" view. Adding
//     options must not change what users see today, so the default landing view
//     stays Active (NOT All).
//   - `?tab=all|active|locked|archived` → that view.
//   - any invalid/unknown value → the default "active" view. A DEFINED, tested
//     fallback replacing the previous silent `→ active` narrowing, so a
//     bookmarked / legacy URL never errors or misrenders.
//
// Co-tenancy note: the design-conformance seeded harness mounts the marketplace
// grid (marketplace-tab-model, default "all") AND this installed filter on ONE
// route, both reading `?tab=`. This filter OWNS the values all|active|locked|
// archived; the grid resolves each of them to its own "all" tab and LEAVES the
// value in the URL (never strips a value it did not own), so the two controls
// coexist on the shared query key without clobbering each other.
// ---------------------------------------------------------------------------

/**
 * The installed-extensions status filter options, in the order the selector
 * renders them: All, Active, Locked, Archived (cinatra#1571 AC1). Single source
 * of truth for both the rendered control and the canonical `?tab=` value set.
 */
export const INSTALLED_TABS = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "locked", label: "Locked" },
  { value: "archived", label: "Archived" },
] as const;

export type InstalledTabValue = (typeof INSTALLED_TABS)[number]["value"];

/** The default view when no (or an invalid) `?tab=` value is present. */
export const DEFAULT_INSTALLED_TAB: InstalledTabValue = "active";

const CANONICAL_TAB_VALUES: ReadonlySet<string> = new Set(
  INSTALLED_TABS.map((t) => t.value),
);

/** Whether a raw string is one of the four canonical status-filter values. */
export function isInstalledTabValue(raw: string): raw is InstalledTabValue {
  return CANONICAL_TAB_VALUES.has(raw);
}

/**
 * Narrow a raw `?tab=` search-param value (a Next.js searchParam is
 * `string | string[] | undefined`) to the view to render:
 *   - absent / empty                       → the default "active" view;
 *   - "all" | "active" | "locked" | "archived" → that view;
 *   - any other (invalid/unknown) value    → the default "active" view.
 * The fallback is defined and tested (cinatra#1571 AC2) — never a 404, never a
 * dead/misrendered tab for a legacy or hand-edited URL.
 */
export function resolveInstalledTab(
  raw: string | string[] | null | undefined,
): InstalledTabValue {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === "string" && isInstalledTabValue(value)) return value;
  return DEFAULT_INSTALLED_TAB;
}
