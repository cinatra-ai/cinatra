/**
 * Marketplace VISIBILITY of an installed extension row (cinatra#3447).
 *
 * The §V settings page reads this value in one place only: the publish gate
 * (`canPublishToMarketplace`), where a public row keeps the live action off
 * because the promote action refuses a row already recorded as public. §V draws
 * no "already published" state, so the value never draws a line of its own; the
 * Marketplace group always draws one of its three drawn states. The row
 * assembly used to answer "is this extension published?" with
 * `"public"` whenever there was nothing to read: an extension that was never
 * published anywhere carries no registry origin at all, and an ABSENT origin is
 * not a public visibility. It is the kind's own native row first (an agent
 * template carries its origin block), then the catalog summary's origin, and
 * "published" only when one of them SAYS so.
 *
 * THE GRANDFATHER CLAUSE IS KEPT. `AgentPackageSummary.origin`
 * (packages/registries/src/types.ts) is null for a package PUBLISHED before the
 * visibility convention existed, and its contract tells callers to default that
 * null to "public". So the absent-origin reading turns on whether a marketplace
 * catalog summary exists at all: a row WITH a summary and no origin block is a
 * legacy published package and still reads public; a row with no summary at all
 * was published nowhere and reads private.
 *
 * Pure and dependency-free, in its own leaf beside `installed-vendor` — the
 * loader that assembles the row is `server-only`, and this rule is read by the
 * settings page's render tests without it.
 */

export type InstalledRowVisibility = "public" | "private";

/** The catalog summary's origin block, reduced to the field that decides. */
export type InstalledRowOrigin = { visibility?: string | null } | null | undefined;

export function resolveInstalledRowVisibility(input: {
  /** The kind's own native descriptor verdict (agent origin), null when it has none. */
  nativeVisibility: InstalledRowVisibility | null | undefined;
  /** The registry catalog summary's `cinatra.origin` block, null when there is none. */
  origin: InstalledRowOrigin;
  /**
   * Whether the package carries a marketplace CATALOG SUMMARY at all. With a
   * summary but no origin block the package is a legacy published one and the
   * registries contract grandfathers it public; with no summary there is no
   * publication to report. Omitted (legacy two-field call): no summary.
   */
  hasCatalogSummary?: boolean;
}): InstalledRowVisibility {
  if (input.nativeVisibility) return input.nativeVisibility;
  if (input.origin) return input.origin.visibility === "private" ? "private" : "public";
  // No origin block at all. Published-before-the-convention (a catalog summary
  // exists) stays public by the registries grandfather clause; nothing else
  // published this extension anywhere, so the page must not declare it
  // published (cinatra#3447).
  return input.hasCatalogSummary ? "public" : "private";
}
