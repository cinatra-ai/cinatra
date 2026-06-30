/**
 * Marketplace browse card model (storefront browse parity).
 *
 * The `/configuration/marketplace` listing renders the storefront catalog
 * sourced from the marketplace `extension_list` ability, mapping each entry into
 * the `MarketplaceCardData` shape the screen renders.
 *
 * These mappers are PURE (no IO) so they are unit-testable; the orchestration
 * (token resolution + ability call) lives in `@/lib/marketplace-browse`.
 */

import type { MarketplaceCatalogEntry } from "@cinatra-ai/marketplace-mcp-client";
import { comparePluginVersions } from "@cinatra-ai/registries";

export type MarketplaceCardKind =
  | "agent"
  | "skill"
  | "connector"
  | "artifact"
  | "workflow"
  | "unknown";

/** Commerce badge mirrored from the storefront card ("Open source"/"Free"/price). */
export interface MarketplaceCommerceBadge {
  text: string;
  variant: "oss" | "free" | "price";
}

export interface MarketplaceCardData {
  /** Install identifier — the scoped npm name. */
  packageName: string;
  /** Install identifier — the listed version. Always non-empty. */
  packageVersion: string;
  displayName: string;
  description: string | null;
  kindSlug: MarketplaceCardKind;
  kindLabel: string;
  /** Commerce badge mirrored from the storefront entry; null when it has none. */
  badge: MarketplaceCommerceBadge | null;
  /** ISO-8601 UTC freshness ("Updated N ago") or null. */
  freshnessAt: string | null;
  /** Rating mirrored from the storefront entry; null when it has none. */
  rating: { average: number; count: number } | null;
  /** /configuration/marketplace/<scope>/<name> (unchanged detail route). */
  detailHref: string;
  /**
   * Total install count, or null when the marketplace does not (yet) track it.
   * OPTIONAL — the card renders the count only when a non-negative finite
   * number is present; any absent/garbage value degrades to "no count line".
   */
  installCount: number | null;
  /**
   * Sanitized hosted URL for the extension's own square icon, or null. First
   * link in the card icon fallback chain (icon → vendor logo → kind emblem).
   */
  iconUrl: string | null;
  /**
   * Sanitized hosted URL for the vendor brand logo, or null. Second link in the
   * card icon fallback chain.
   */
  vendorLogoUrl: string | null;
  /**
   * Declared host/SDK ABI range (`cinatra.sdkAbiRange`), or null when the
   * extension declares none. Powers the in-instance 3-state compatibility
   * badge for NOT-installed listings (absent → neutral "Unknown", never green).
   */
  sdkAbiRange: string | null;
}

/**
 * Coerce an arbitrary wire value into a non-negative finite install count, or
 * null. The card renders a count line ONLY for a clean number — a missing
 * field, a string, NaN, Infinity, or a negative number all collapse to null
 * (no count line), so a malformed catalog never paints a garbage statistic.
 */
function normalizeInstallCount(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return null;
  }
  return Math.floor(raw);
}

/**
 * Coerce an arbitrary wire value into a non-empty trimmed string, or null.
 * Used for the OPTIONAL asset URLs and the declared ABI range (older catalogs
 * omit them), so any non-string / blank value degrades gracefully to null — the
 * next link in the icon fallback chain, or the neutral "Unknown" compat state.
 */
function normalizeOptionalString(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const KIND_LABELS: Record<MarketplaceCardKind, string> = {
  agent: "Agent",
  skill: "Skill",
  connector: "Connector",
  artifact: "Artifact",
  workflow: "Workflow",
  unknown: "Extension",
};

const KNOWN_KINDS: ReadonlySet<string> = new Set([
  "agent",
  "skill",
  "connector",
  "artifact",
  "workflow",
]);

function normalizeKind(slug: string | null | undefined): MarketplaceCardKind {
  return slug && KNOWN_KINDS.has(slug) ? (slug as MarketplaceCardKind) : "unknown";
}

/** Detail route — drops the leading "@"; the route re-adds it. */
export function marketplaceDetailHref(packageName: string): string {
  return `/configuration/marketplace/${packageName.replace(/^@/, "")}`;
}

// Strict scoped npm name: lowercase "@scope/name", single slash, no spaces /
// uppercase / extra path segments / leading special chars; npm's 214-char cap.
const SCOPED_NPM_NAME_RE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
// Official SemVer 2.0.0 regex (https://semver.org). Rejects leading zeros,
// empty/double-dotted prerelease identifiers, and multiple build-metadata "+".
const STRICT_SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * A card is only renderable when it carries a REAL, installable identifier:
 * a strict scoped npm name (also the basis of the detail route) AND a strict
 * SemVer version. Defense-in-depth on the storefront wire — a malformed
 * identifier must never bind Install or produce a broken
 * `/configuration/marketplace/<scope>/<name>` route.
 */
export function isValidInstallIdentity(packageName: string, version: string): boolean {
  return (
    packageName.length > 0 &&
    packageName.length <= 214 &&
    SCOPED_NPM_NAME_RE.test(packageName) &&
    STRICT_SEMVER_RE.test(version)
  );
}

// A leading markdown ATX heading marker ("# ", "## ", … up to 6, with at least
// one trailing space/tab). Anchored + bounded, so it's linear (no backtracking).
const LEADING_ATX_HEADING_RE = /^\s*#{1,6}[ \t]+/;

/**
 * Normalize a storefront entry description into clean plain text for the card
 * SUMMARY. The card renders the description raw in a `<p>` (no markdown), and
 * the storefront flattens each package README into a single-line description
 * that still carries the leading H1 marker (e.g. `# Email Outreach Agent Run
 * an outbound…`), so the literal `#` leaks onto every card. Strip ONLY a
 * leading ATX heading marker — requiring whitespace after the hashes preserves
 * a legitimate mid/lead token like `#1 ranked` or `#hashtag` — then trim;
 * a now-empty string collapses to `null` (matching the `string | null`
 * contract, so an empty summary never renders).
 *
 * Card-summary normalization only: the full-markdown README detail view
 * (cinatra#18/#19) renders elsewhere and is intentionally untouched.
 */
export function normalizeCardDescription(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const stripped = raw.replace(LEADING_ATX_HEADING_RE, "").trim();
  return stripped.length > 0 ? stripped : null;
}

/**
 * Map a storefront catalog entry to the screen card model.
 *
 * Returns `null` (defense-in-depth) when the entry lacks a valid install
 * identifier — the ability already fails closed on missing
 * `{package_name, version}`, so this should never trigger for real data, but a
 * null guard guarantees every rendered card binds a real Install action.
 */
export function catalogEntryToCardData(
  entry: MarketplaceCatalogEntry,
): MarketplaceCardData | null {
  const packageName = typeof entry.package_name === "string" ? entry.package_name.trim() : "";
  const packageVersion = typeof entry.version === "string" ? entry.version.trim() : "";
  if (!isValidInstallIdentity(packageName, packageVersion)) {
    return null;
  }
  const kindSlug = normalizeKind(entry.kind_slug);
  return {
    packageName,
    packageVersion,
    displayName: entry.display_name || packageName,
    description: normalizeCardDescription(entry.description),
    kindSlug,
    kindLabel: entry.kind_label || KIND_LABELS[kindSlug],
    badge: entry.badge
      ? { text: entry.badge.text, variant: entry.badge.variant }
      : null,
    freshnessAt: entry.freshness_at ?? null,
    rating: entry.rating ?? null,
    detailHref: marketplaceDetailHref(packageName),
    // New OPTIONAL catalog fields — every one degrades gracefully when the
    // marketplace build predates the field (absent → null, no broken UI).
    installCount: normalizeInstallCount(entry.install_count),
    iconUrl: normalizeOptionalString(entry.icon_url),
    vendorLogoUrl: normalizeOptionalString(entry.vendor_logo_url),
    sdkAbiRange: normalizeOptionalString(entry.sdk_abi_range),
  };
}

// ---------------------------------------------------------------------------
// CTA state — pure resolver (the screen renders from this; tested directly).
// ---------------------------------------------------------------------------

export type MarketplaceCardCta =
  | { state: "restore" }
  | { state: "install"; disabled: boolean }
  | { state: "update"; disabled: boolean }
  | { state: "installed" };

/**
 * Resolve the 4-state Install/Update/Installed/Restore CTA for a card.
 * - archived → Restore (DB-only reactivation).
 * - not installed → Install (disabled when the registry is disconnected — the
 *   tarball comes from the registry, so a live CTA must be able to install).
 * - installed + a SEMVER-newer catalog version → Update (same registry gating).
 * - installed + current/newer → Installed.
 * Update detection uses `comparePluginVersions` (semver), so a prerelease never
 * triggers a spurious "Update Now".
 */
export function resolveMarketplaceCardCta(
  card: Pick<MarketplaceCardData, "packageVersion">,
  installedInfo: { version: string; isArchived: boolean } | undefined,
  registryConnected: boolean,
): MarketplaceCardCta {
  if (installedInfo?.isArchived) {
    return { state: "restore" };
  }
  if (installedInfo === undefined) {
    return { state: "install", disabled: !registryConnected };
  }
  if (comparePluginVersions(installedInfo.version, card.packageVersion) === "update-available") {
    return { state: "update", disabled: !registryConnected };
  }
  return { state: "installed" };
}
