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
   * The extension's OWN self-describing logo — the sanitized inline-SVG data
   * URI generated from `cinatra.logo` (`manifest.logo`), or null when the
   * extension declares none / is not locally known. FIRST tier of the card
   * icon chain, aligned with `/connectors` (cinatra#1325): resolving the card
   * from the extension's own logo makes a connector card render the identical
   * connector identity `/connectors` resolves for the same package — instead
   * of degrading to the generic kind emblem. Same source `/connectors` reads
   * (`STATIC_EXTENSION_MANIFEST[pkg].logo`), injected by the browse loader.
   */
  manifestLogoUrl: string | null;
  /**
   * The extension's slug (the scoped npm name minus its scope, e.g.
   * `@cinatra-ai/youtube-connector` → `youtube-connector`), or null. Keys the
   * host CLIENT ICON MAP tier (`ICON_BY_SLUG`) — the SECOND tier, the same
   * brand-mark map `/connectors` falls back to when `manifest.logo` is null
   * (cinatra#1325). Resolved to a node at render (the pure model stays
   * React-free); a slug with no mapped brand mark falls through to the catalog
   * icon tier.
   */
  iconSlug: string | null;
  /**
   * Sanitized hosted URL for the extension's square icon from the marketplace
   * CATALOG, or null. THIRD tier of the card icon chain (after the extension's
   * own `manifest.logo` and the host client-icon map — cinatra#1325).
   */
  iconUrl: string | null;
  /**
   * Sanitized hosted URL for the vendor brand logo, or null. FOURTH tier of
   * the card icon chain (before the kind emblem).
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
 * Scheme guard for a hosted (remote) card-icon URL: passes ONLY `http(s)`,
 * matching `safeHttpUrl` on the render side (defence-in-depth on the catalog
 * icon / vendor-logo tiers, which are arbitrary marketplace-supplied URLs). A
 * blank / non-string / non-http(s) value degrades to null (the next tier).
 */
function safeHostedImageSrc(raw: unknown): string | null {
  const value = normalizeOptionalString(raw);
  if (value === null) return null;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

// The EXACT inline-logo data-URI form the manifest generator emits — a
// base64-encoded, sanitized SVG (`scripts/extensions/generate-extension-manifest.mjs`).
// Bounded ON PURPOSE (codex round-0): a bare `data:` guard would admit any
// inline payload; the card renders `manifest.logo` in an `<img>`, so only this
// one sanitizer-produced image form is trusted. Case-insensitive on the media
// type; the base64 marker is required.
const MANIFEST_LOGO_DATA_URI_RE = /^data:image\/svg\+xml;base64,[a-z0-9+/]+=*$/i;

/**
 * Scheme guard for the extension's OWN logo (`manifest.logo`). Unlike the
 * remote catalog tiers, this is the sanitized inline-SVG DATA URI the manifest
 * generator emits (the exact value `/connectors` renders directly). It admits
 * ONLY that bounded `data:image/svg+xml;base64,…` form (never a bare/arbitrary
 * `data:` payload, never `javascript:`) plus a plain `http(s)` hosted URL;
 * anything else → null (the next tier). Kept pure + local so the client-safe
 * model pulls no URL helper across the package boundary.
 */
export function safeManifestLogoSrc(raw: unknown): string | null {
  const value = normalizeOptionalString(raw);
  if (value === null) return null;
  if (MANIFEST_LOGO_DATA_URI_RE.test(value)) return value;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Derive the extension slug that keys the host client-icon map: the scoped npm
 * name minus its scope (`@cinatra-ai/youtube-connector` → `youtube-connector`),
 * matching the `/connectors` registry slug + `ICON_BY_SLUG` keys (cinatra#1325).
 * A bare (unscoped) name is returned as-is; a blank/garbage value → null.
 */
export function deriveIconSlug(packageName: string): string | null {
  const name = normalizeOptionalString(packageName);
  if (name === null) return null;
  const slash = name.lastIndexOf("/");
  const slug = slash >= 0 ? name.slice(slash + 1) : name;
  return slug.length > 0 ? slug : null;
}

/**
 * Map the catalog entry's OPTIONAL vendor block into the card's publisher
 * ref. The wire shape mirrors the public REST detail's `vendor` object
 * (`{name, slug, store_url}`), but ONLY the human `name` feeds the byline: the
 * slug is a machine identifier and is NEVER substituted for the display name
 * (cinatra#1528). A block with no non-empty `name` degrades to null — the §I
 * render then resolves that to the explicit missing-vendor state via
 * `resolveVendorPresentation`, so the byline is never a slug and never silently
 * dropped. The store URL passes through UNVALIDATED — the render side owns the
 * http(s) scheme guard (`safeHttpUrl`), same as the detail modal — and is
 * dropped along with the block when no name survives (a nameless vendor is
 * never linked).
 */
function normalizeCardVendor(
  raw: MarketplaceCatalogEntry["vendor"],
): MarketplaceCardData["vendor"] {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const name = normalizeOptionalString(raw.name);
  if (!name) {
    return null;
  }
  return { name, storeUrl: normalizeOptionalString(raw.store_url) };
}

/**
 * Trim + case-fold a candidate for anti-lookalike IDENTITY comparison. npm
 * names are lowercase by spec (`SCOPED_NPM_NAME_RE`), but a catalog value that
 * echoes the identity may vary case, so both sides are folded before the
 * equality test. Case-fold ONLY — no hyphen/underscore→space rewrite — so a
 * genuine human name that merely de-hyphenates the slug ("Blog Skills" vs the
 * slug "blog-skills") stays DISTINCT and still wins tier-1.
 */
function foldIdentity(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * True when `candidate` is the package IDENTITY wearing a `display_name` — the
 * raw scoped npm name, or one of the machine-identifier forms the codebase
 * ALREADY derives from it:
 *   - the exact scoped name (`@cinatra-ai/mcp-client-connector`);
 *   - the detail-route form with the leading "@" dropped
 *     (`cinatra-ai/mcp-client-connector`, `marketplaceDetailHref`);
 *   - the unscoped slug (`mcp-client-connector`, `deriveIconSlug`).
 *
 * These are exactly the identity transformations the app performs elsewhere;
 * treating a `display_name` equal to any of them as the machine identifier (not
 * a human name) is the SAME anti-lookalike discipline the vendor byline applies
 * — it never lets a slug / package scope stand in for a human display name
 * (cinatra#1528 / #1589). Compared trim- and case-insensitively (`foldIdentity`)
 * but NOT prettified: the raw slug "blog-skills" matches, while a genuinely
 * distinct catalog name ("MCP Clients", "Blog Skills") does not.
 */
function isPackageNameLookalike(candidate: string, packageName: string): boolean {
  const folded = foldIdentity(candidate);
  if (folded.length === 0) return false;
  const pkg = foldIdentity(packageName);
  if (folded === pkg) return true; // exact scoped npm name
  if (folded === pkg.replace(/^@/, "")) return true; // detail-route form (marketplaceDetailHref)
  const slug = deriveIconSlug(packageName); // unscoped slug (deriveIconSlug)
  if (slug !== null && folded === foldIdentity(slug)) return true;
  return false;
}

/**
 * Resolve the card's human display name in the design-spec fallback order
 * (cinatra#1605). Every rendered name on `/configuration/marketplace` — the
 * listing-card title, the install popup title, and the detail modal, which all
 * consume `card.displayName` — binds `manifest.displayName` per the pinned spec
 * (`data-field="name=manifest.displayName"`), NEVER the raw package name.
 *
 * Highest priority first:
 *   1. a NON-EMPTY, trimmed catalog `display_name` — the current marketplace
 *      data wins (a listed package keeps the name it already rendered) — UNLESS
 *      that value merely echoes the package IDENTITY (the raw scoped name, or a
 *      machine-identifier form the app derives from it — `isPackageNameLookalike`).
 *      Such a value is NOT a human name, so it is treated as ABSENT and tier 2
 *      fires. This is the cinatra#1605 live finding: the production storefront
 *      stores the package name AS `display_name` for 54/83 entries, so a plain
 *      "non-empty wins" leaked the raw package name for the majority of
 *      extensions and the manifest rescue never fired. (The DURABLE fix is the
 *      catalog backfill — mkt#217 / mkt#229, on the release wave; this is the
 *      app-side defensive resolution.)
 *   2. the extension's SELF-DECLARED `cinatra.displayName` from the generated
 *      static manifest, matched by EXACT package identity in the browse loader —
 *      this rescues a bundled extension whose catalog entry omits (or echoes the
 *      package name in) the field (e.g. `@cinatra-ai/default-artifact` →
 *      "Default Artifact");
 *   3. the raw package name — a TRUE LAST RESORT, meaning neither the catalog
 *      nor the static manifest supplied a human name (a data gap, not a routine
 *      state). Shown verbatim: never prettified into a fake human name, and the
 *      slug is never substituted for a display name (the same anti-lookalike
 *      discipline as the vendor byline, cinatra#1528).
 *
 * Blank / whitespace values at any tier are treated as absent
 * (`normalizeOptionalString`), so a `"  "` catalog `display_name` falls through
 * to the manifest rather than rendering as an empty title. A genuinely distinct
 * catalog name always wins tier 1.
 */
export function resolveCardDisplayName(
  catalogDisplayName: string | null | undefined,
  manifestDisplayName: string | null | undefined,
  packageName: string,
): string {
  const catalog = normalizeOptionalString(catalogDisplayName);
  // A catalog value that merely echoes the package identity is treated as
  // ABSENT (cinatra#1605), so the manifest rescue below can fire instead of
  // rendering the raw package name as if it were a human name.
  const catalogHumanName =
    catalog !== null && !isPackageNameLookalike(catalog, packageName) ? catalog : null;
  return (
    catalogHumanName ??
    normalizeOptionalString(manifestDisplayName) ??
    packageName
  );
}

const KIND_LABELS: Record<MarketplaceCardKind, string> = {
  agent: "Agent",
  skill: "Skill",
  connector: "Connector",
  artifact: "Artifact",
  unknown: "Extension",
};

// The four extension kinds. A slug outside this set — the removed "workflow"
// kind (cinatra#1035), or any unmapped/future value off the storefront wire —
// normalizes to "unknown" (label "Extension"), rendered only under "All": the
// listing degrades gracefully to a neutral card instead of crashing or painting
// a workflow-kind label/filter.
const KNOWN_KINDS: ReadonlySet<string> = new Set([
  "agent",
  "skill",
  "connector",
  "artifact",
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
  opts?: {
    /**
     * The extension's OWN logo (`manifest.logo`) — the sanitized inline-SVG
     * data URI from `STATIC_EXTENSION_MANIFEST[pkg].logo` — injected by the
     * server-side browse loader for a locally-known package (cinatra#1325). The
     * remote catalog does not carry it, so an un-enriched call (or a package the
     * host does not bundle) leaves the first icon tier empty and the chain
     * degrades exactly as before. Guarded here (`safeManifestLogoSrc`).
     */
    manifestLogo?: string | null;
    /**
     * The extension's SELF-DECLARED human name (`cinatra.displayName` =
     * `STATIC_EXTENSION_MANIFEST[pkg].displayName`), injected by the server-side
     * browse loader for a locally-known (bundled) package (cinatra#1605),
     * matched by EXACT package identity (no fuzzy match). The remote catalog
     * does not carry the manifest, so a not-bundled package leaves this null and
     * the name resolution falls through to the catalog `display_name` or, only
     * as a true last resort, the package name (`resolveCardDisplayName`).
     */
    manifestDisplayName?: string | null;
  },
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
    // cinatra#1605: resolve a human name (catalog display_name → static manifest
    // displayName → package name LAST), so a bundled extension whose catalog
    // entry omits display_name renders its manifest name — not the raw package
    // name — everywhere `card.displayName` feeds (card title, install popup,
    // detail modal).
    displayName: resolveCardDisplayName(
      entry.display_name,
      opts?.manifestDisplayName,
      packageName,
    ),
    description: normalizeCardDescription(entry.description),
    kindSlug,
    // Trust the wire kind_label only for a KNOWN kind. When the kind normalizes
    // to "unknown" — the removed "workflow" (cinatra#1035) or any unmapped slug
    // — force the neutral "Extension" label so a stale wire label ("Workflow")
    // can never reintroduce a workflow-kind label on the card.
    kindLabel: kindSlug === "unknown" ? KIND_LABELS.unknown : entry.kind_label || KIND_LABELS[kindSlug],
    badge: entry.badge
      ? { text: entry.badge.text, variant: entry.badge.variant }
      : null,
    freshnessAt: entry.freshness_at ?? null,
    rating: entry.rating ?? null,
    detailHref: marketplaceDetailHref(packageName),
    // New OPTIONAL catalog fields — every one degrades gracefully when the
    // marketplace build predates the field (absent → null, no broken UI).
    installCount: normalizeInstallCount(entry.install_count),
    // cinatra#1325: the extension's OWN logo (cinatra.logo → manifest.logo) is
    // the FIRST icon tier and its slug keys the host client-icon map (SECOND
    // tier), so a connector card resolves the same identity `/connectors` does.
    manifestLogoUrl: safeManifestLogoSrc(opts?.manifestLogo),
    iconSlug: deriveIconSlug(packageName),
    iconUrl: normalizeCatalogAssetUrl(entry.icon_url),
    vendorLogoUrl: normalizeCatalogAssetUrl(entry.vendor_logo_url),
    sdkAbiRange: normalizeOptionalString(entry.sdk_abi_range),
    vendor: normalizeCardVendor(entry.vendor),
  };
}

/**
 * The resolved card-icon chain (cinatra#1325): the ordered list of hosted-image
 * `<img src>` candidates the tile tries (in order, advancing on load-failure)
 * and which NODE tier renders once they are exhausted/absent.
 */
export interface CardIconChain {
  /**
   * Ordered `<img src>` candidates — tried first→last, advancing to the next
   * on a load failure (the render walks them). Never contains a null/blank.
   */
  imageSrcs: string[];
  /**
   * The terminal NODE tier, rendered after every `imageSrcs` candidate is
   * absent or fails to load: the host client-icon-map brand mark
   * (`"client-icon"`) or the generic kind emblem (`"kind-emblem"`). A React
   * node always renders, so it is the guaranteed tail of the chain — never a
   * blank tile (issue AC#4).
   */
  emblem: "client-icon" | "kind-emblem";
}

/**
 * Resolve the card-icon fallback chain in the explicit order the design spec
 * (§IV) + `/connectors` share — cinatra#1325:
 *
 *   manifest.logo → client icon map → catalog icon_url → vendor logo → kind emblem
 *
 * A React SVG node (the client-icon-map brand mark, the kind emblem) ALWAYS
 * renders — it can never fail to load — so the FIRST node tier reached
 * terminates the chain. That is why, when the slug HAS a client-icon
 * (`hasClientIcon`), the catalog-icon + vendor-logo `<img>` tiers are dropped:
 * the client-icon node sits above them in the order and would always win, so
 * they are unreachable. This models "client icon beats catalog icon" exactly:
 *
 *   - hasClientIcon:  [manifest.logo?] then terminal client-icon
 *       (manifest.logo shows if present + decodes; on load-failure or absence
 *        it degrades to the client-icon brand mark — order tiers 1 → 2).
 *   - else:           [manifest.logo?, catalog?, vendor?] then terminal kind-emblem
 *       (the legacy chain, now with manifest.logo prepended — tiers 1,3,4 → 5).
 *
 * PURE + React-free (the client-safe model): `hasClientIcon` is supplied by the
 * render, which owns the host client-icon map (a `"use client"` node map that
 * must not be pulled into this client-safe model). The terminal node itself is
 * materialized at render from `emblem`.
 */
export function resolveCardIconChain(
  card: Pick<MarketplaceCardData, "manifestLogoUrl" | "iconUrl" | "vendorLogoUrl">,
  opts: { hasClientIcon: boolean },
): CardIconChain {
  const manifestLogo = safeManifestLogoSrc(card.manifestLogoUrl);
  if (opts.hasClientIcon) {
    return {
      imageSrcs: manifestLogo ? [manifestLogo] : [],
      emblem: "client-icon",
    };
  }
  // DEDUPE while preserving order (codex round-1 BLOCKER): the catalog icon and
  // vendor logo can be the SAME URL (or equal manifest.logo). The render keys
  // each `<img>` by its src, so a repeated src → same key + same src → React
  // reuses the node on advance and the `onError` never re-fires — the chain
  // would STALL on a shared dead URL and never reach the kind emblem (AC#4). A
  // deduplicated chain guarantees every advance is a genuinely new `<img>`.
  const seen = new Set<string>();
  const imageSrcs: string[] = [];
  for (const src of [
    manifestLogo,
    safeHostedImageSrc(card.iconUrl),
    safeHostedImageSrc(card.vendorLogoUrl),
  ]) {
    if (src !== null && !seen.has(src)) {
      seen.add(src);
      imageSrcs.push(src);
    }
  }
  return { imageSrcs, emblem: "kind-emblem" };
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
