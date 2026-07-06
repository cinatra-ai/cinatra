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
// Deep module import ON PURPOSE (cinatra#985): this model is client-safe (the
// conformance harness renders the six-state CTA resolver in the browser), but
// the registries BARREL pulls pacote/node-gyp (child_process reach) — via the
// barrel, any client import of this file breaks `pnpm build`. version-compare
// is the pure semver helper only.
import { comparePluginVersions } from "@cinatra-ai/registries/src/version-compare";
import type { ExtensionCompatState } from "@/lib/extension-compat-badge";

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
  /**
   * Publisher for the §IV "{Type} by {Vendor}" line, or null when the catalog
   * entry carries no vendor block (older marketplace builds). `name` is
   * guaranteed non-empty; `storeUrl` is the vendor's marketplace store URL,
   * scheme-guarded AT RENDER (never trusted here) and null when absent.
   */
  vendor: { name: string; storeUrl: string | null } | null;
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

/**
 * Extract + normalize a catalog asset URL (icon/vendor-logo). The live
 * storefront catalog serves these as a WP-media descriptor `{url, width,
 * height}` — the SAME shape the public detail endpoint's `icon_url` already
 * carries (cinatra#1003: a bare-`string` type here previously discarded every
 * real asset, since `normalizeOptionalString` rejects a non-string outright,
 * silently nulling the vendor logo on every listing). A pre-descriptor
 * catalog build may still emit a bare string, so both shapes degrade
 * correctly; anything else (missing `url`, blank, wrong type) → null, the
 * next link in the icon fallback chain.
 */
function normalizeCatalogAssetUrl(raw: unknown): string | null {
  if (typeof raw === "string") {
    return normalizeOptionalString(raw);
  }
  if (raw && typeof raw === "object" && "url" in raw) {
    return normalizeOptionalString((raw as { url?: unknown }).url);
  }
  return null;
}

/**
 * Map the catalog entry's OPTIONAL vendor block into the card's publisher
 * ref. The wire shape mirrors the public REST detail's `vendor` object
 * (`{name, slug, store_url}`); every field is optional/nullable, so this
 * degrades to null (no publisher line) whenever no non-empty name or slug is
 * present. The store URL passes through UNVALIDATED — the render side owns
 * the http(s) scheme guard (`safeHttpUrl`), same as the detail modal.
 */
function normalizeCardVendor(
  raw: MarketplaceCatalogEntry["vendor"],
): MarketplaceCardData["vendor"] {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const name =
    normalizeOptionalString(raw.name) ?? normalizeOptionalString(raw.slug);
  if (!name) {
    return null;
  }
  return { name, storeUrl: normalizeOptionalString(raw.store_url) };
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
    iconUrl: normalizeCatalogAssetUrl(entry.icon_url),
    vendorLogoUrl: normalizeCatalogAssetUrl(entry.vendor_logo_url),
    sdkAbiRange: normalizeOptionalString(entry.sdk_abi_range),
    vendor: normalizeCardVendor(entry.vendor),
  };
}

/**
 * The centred price-row label (design spec §IV): "Free, Open Source" for an
 * open-source listing, "Free" for a free commercial one, the storefront's
 * formatted price text (e.g. "$9/mo") for a paid one. A card without a
 * commerce badge renders no price row (the storefront guarantees a badge on
 * every listing, so this is wire defence, not a real state).
 */
export function resolveCardPriceLabel(
  badge: MarketplaceCommerceBadge | null,
): string | null {
  if (!badge) return null;
  switch (badge.variant) {
    case "oss":
      return "Free, Open Source";
    case "free":
      return "Free";
    case "price":
      return badge.text;
  }
}

// ---------------------------------------------------------------------------
// CTA state — pure resolver (the screen renders from this; tested directly).
// ---------------------------------------------------------------------------

export type MarketplaceCardCta =
  | { state: "restore" }
  | { state: "install"; disabled: boolean }
  | { state: "update"; disabled: boolean }
  | { state: "installed" }
  | { state: "incompatible"; blockedAction: "install" | "update" };

/**
 * Resolve the six-state CTA for a card (design spec §IV: Install now /
 * Installed / Update now / Restore / Installing… / Incompatible).
 * - archived → Restore (DB-only reactivation of the already-installed
 *   version; no new package is fetched/activated, so neither registry state
 *   nor the CATALOG version's ABI compat gates it).
 * - not installed + a DECLARED ABI this host does not satisfy → Incompatible
 *   (the activation gate would refuse the install, so the CTA must never be
 *   softer than that gate: a greyed-out, unactionable Install). The verdict
 *   comes from `deriveExtensionCompatState` — "unknown" (no declared range)
 *   stays installable, exactly like the lenient install gate.
 * - not installed → Install (disabled when the registry is disconnected — the
 *   tarball comes from the registry, so a live CTA must be able to install).
 * - installed + a SEMVER-newer catalog version whose DECLARED ABI this host
 *   does not satisfy → Incompatible with `blockedAction: "update"` (updating
 *   would fetch + activate the incompatible catalog version — the same gate
 *   refusal as install, so the Update greys out too). The installed version
 *   keeps running; only the catalog action is blocked.
 * - installed + a SEMVER-newer compatible catalog version → Update (registry
 *   gating as for install).
 * - installed + current/newer → Installed (no action to gate).
 * Update detection uses `comparePluginVersions` (semver), so a prerelease never
 * triggers a spurious "Update now". The sixth visual state, Installing…, is
 * the pending label of the install form's submit (useFormStatus), layered on
 * "install"/"update"/"restore" at render time.
 */
export function resolveMarketplaceCardCta(
  card: Pick<MarketplaceCardData, "packageVersion">,
  installedInfo: { version: string; isArchived: boolean } | undefined,
  registryConnected: boolean,
  compatState: ExtensionCompatState,
): MarketplaceCardCta {
  if (installedInfo?.isArchived) {
    return { state: "restore" };
  }
  if (installedInfo === undefined) {
    if (compatState === "incompatible") {
      return { state: "incompatible", blockedAction: "install" };
    }
    return { state: "install", disabled: !registryConnected };
  }
  if (comparePluginVersions(installedInfo.version, card.packageVersion) === "update-available") {
    if (compatState === "incompatible") {
      return { state: "incompatible", blockedAction: "update" };
    }
    return { state: "update", disabled: !registryConnected };
  }
  return { state: "installed" };
}
