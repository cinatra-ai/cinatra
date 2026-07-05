import "server-only";

/**
 * Marketplace browse data source (storefront browse parity).
 *
 * Sources the `/configuration/marketplace` listing from the live storefront's
 * anonymous public REST catalog. Browse never sends a marketplace bearer.
 * Install + vendor/admin features stay bearer-backed.
 */

import {
  fetchPublicMarketplaceExtensionList,
  fetchPublicMarketplaceExtensionDetail,
} from "@cinatra-ai/marketplace-mcp-client/http-client";
import { MarketplaceMcpError } from "@cinatra-ai/marketplace-mcp-client";
import type {
  MarketplaceCatalogEntry,
  MarketplaceExtensionGetOutput,
  MarketplaceExtensionListInput,
} from "@cinatra-ai/marketplace-mcp-client";
import { InstanceNamespaceNotConfiguredError } from "@cinatra-ai/registries";
import {
  catalogEntryToCardData,
  type MarketplaceCardData,
} from "@cinatra-ai/extensions/screens";
import { loadVerdaccioConfigForReads } from "@/lib/verdaccio-config";
import { VendorCredentialsMissingError } from "@/lib/marketplace-credentials";
import {
  emptyRatingSummary,
  normalizeDetailChangelog,
  normalizeDetailDependencies,
  safeHttpUrl,
  type MarketplaceDetailLoadResult,
  type MarketplaceDetailView,
} from "@/lib/marketplace-detail-view";

/**
 * A malformed public catalog payload — a distinct subclass (still a
 * `MarketplaceMcpError`) whose message/responseBody carries the raw payload for
 * debugging. Malformed responses ALWAYS surface loudly; they are never silently
 * treated as an empty catalog.
 */
class MarketplaceMalformedResponseError extends MarketplaceMcpError {}

/** Overall cap on the browse catalog (storefront paging). */
const BROWSE_LIMIT = 200;
/** The public catalog clamps a single page to 100. */
const CATALOG_PAGE_SIZE = 100;

type CatalogPageFetcher = (
  input: MarketplaceExtensionListInput,
) => Promise<unknown>;

/**
 * Fetch the storefront catalog, paging past the server's 100-per-call clamp up
 * to BROWSE_LIMIT. Stops at `total`, a short page, or the cap. Any page error
 * propagates to the caller (browse surfaces marketplace failures loudly).
 */
async function fetchStorefrontCatalog(
  fetchPage: CatalogPageFetcher,
): Promise<MarketplaceCatalogEntry[]> {
  const items: MarketplaceCatalogEntry[] = [];
  let offset = 0;
  while (items.length < BROWSE_LIMIT) {
    const { items: batch, total } = parseListOutput(
      await fetchPage({ limit: CATALOG_PAGE_SIZE, offset }),
    );
    items.push(...batch);
    if (batch.length < CATALOG_PAGE_SIZE || items.length >= total) {
      break;
    }
    offset += CATALOG_PAGE_SIZE;
  }
  return items.slice(0, BROWSE_LIMIT);
}

/** Catalog sourced from the storefront public catalog. */
export interface MarketplaceBrowseResult {
  kind: "storefront";
  cards: MarketplaceCardData[];
  registryConnected: boolean;
}

/**
 * Validate a public catalog page (the http-client casts the wire JSON
 * straight to the output type, so a malformed payload must be caught here, not
 * silently treated as an empty catalog).
 */
function parseListOutput(raw: unknown): { items: MarketplaceCatalogEntry[]; total: number } {
  const out = raw as { items?: unknown; total?: unknown } | null | undefined;
  if (
    out === null ||
    typeof out !== "object" ||
    !Array.isArray(out.items) ||
    typeof out.total !== "number" ||
    !Number.isFinite(out.total) ||
    out.total < 0
  ) {
    throw new MarketplaceMalformedResponseError(
      "Marketplace public extension catalog: malformed response (expected { items: array, total: non-negative number }).",
      502,
      JSON.stringify(raw)?.slice(0, 500) ?? "",
    );
  }
  return { items: out.items as MarketplaceCatalogEntry[], total: out.total };
}

/**
 * Load the read-side Verdaccio config, returning `null` ONLY when the registry
 * is genuinely not configured (`VENDOR_CREDENTIALS_MISSING`). A corrupted /
 * decrypt-failing attachment (or any other config error) is rethrown so it
 * surfaces loudly — never silently degraded. (No network here — this is a pure
 * config/decrypt load, so any non-"missing" failure is a real problem.)
 */
async function loadInstallableRegistryConfigOrNull(): Promise<
  Awaited<ReturnType<typeof loadVerdaccioConfigForReads>> | null
> {
  try {
    return await loadVerdaccioConfigForReads();
  } catch (err) {
    // Registry genuinely not configured (no Verdaccio identity row, or no
    // consumer/vendor token) → null (banner + disabled Install). A corrupted
    // attachment / decrypt failure / any other error is rethrown loudly.
    if (err instanceof InstanceNamespaceNotConfiguredError) {
      return null;
    }
    if (
      err instanceof VendorCredentialsMissingError &&
      err.code === "VENDOR_CREDENTIALS_MISSING"
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * Load the marketplace browse catalog. Pure-ish orchestration over the public
 * catalog client; the field mapping is delegated to the pure mappers in
 * `@cinatra-ai/extensions/screens`.
 */
export async function loadMarketplaceBrowse(): Promise<MarketplaceBrowseResult> {
  const items = await fetchStorefrontCatalog(fetchPublicMarketplaceExtensionList);
  const cards = items
    .map(catalogEntryToCardData)
    .filter((c): c is MarketplaceCardData => c !== null);
  // `registryConnected` drives the Install/Update CTA + the registry banner.
  // The SOURCE OF TRUTH is whether the registry read-config can ACTUALLY load
  // (a consumer-attached instance installs via its consumerAttachment token
  // regardless of the `registries.remote.status` flag, which can be
  // absent/stale) — NOT the status flag. A corrupt / decrypt-failing config
  // rethrows loudly; only a genuinely-missing config → false.
  const registryConnected = (await loadInstallableRegistryConfigOrNull()) !== null;
  return { kind: "storefront", cards, registryConnected };
}

// Strict scoped npm name ("@scope/name") — the public detail endpoint's own
// route shape. Anything else never reaches the marketplace (→ not_found).
const SCOPED_NPM_NAME_RE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

const KIND_LABEL: Record<string, string> = {
  agent: "Agent",
  skill: "Skill",
  connector: "Connector",
  artifact: "Artifact",
  workflow: "Workflow",
};

/** Project the marketplace ExtensionDetail into the client-safe modal view. */
function toDetailView(
  packageName: string,
  detail: MarketplaceExtensionGetOutput,
): MarketplaceDetailView {
  const kindLabel =
    (typeof detail.kindLabel === "string" && detail.kindLabel.trim() !== ""
      ? detail.kindLabel
      : KIND_LABEL[detail.kind ?? ""]) ?? "Extension";
  return {
    packageName,
    displayName:
      (typeof detail.displayName === "string" && detail.displayName.trim() !== ""
        ? detail.displayName
        : detail.name) || packageName,
    kindLabel,
    cost: detail.commerceBadge?.text ?? null,
    license: detail.commerceBadge?.license ?? detail.license ?? null,
    latestVersion: detail.latestVersion ?? null,
    freshnessAt: detail.freshnessAt ?? null,
    installCount: typeof detail.installCount === "number" ? detail.installCount : null,
    permalink: detail.permalink ?? null,
    sdkAbiRange: detail.sdkAbiRange ?? null,
    readmeMarkdown: detail.readmeMarkdown ?? null,
    longDescription: detail.longDescription ?? null,
    description: detail.description ?? null,
    // Scheme-guard the icon fallback: detail.iconUrl is sanitized upstream but
    // detail.iconAssetUrl is a raw passthrough, so a non-http(s) asset URL would
    // otherwise reach the modal's <img src>. safeHttpUrl drops it to null.
    iconUrl: safeHttpUrl(detail.iconUrl ?? detail.iconAssetUrl),
    // Scheme-guard the banner too: the wire mapper passes bannerUrl through
    // verbatim, so this projection is where a non-http(s) value is dropped
    // before it can reach the modal-hero <img src> (#739).
    bannerUrl: safeHttpUrl(detail.bannerUrl),
    // §V Changelog tab + Dependencies section (cinatra#989). The storefront
    // detail endpoint does not serve either field yet (marketplace#190
    // workstream C) — the normalizers degrade absent/malformed values to the
    // spec empty states (empty-state tab / omitted section).
    changelog: normalizeDetailChangelog(detail.changelog),
    dependencies: normalizeDetailDependencies(detail.dependencies),
    ratingSummary: detail.ratingSummary ?? emptyRatingSummary(),
    reviews: detail.reviews ?? [],
    vendor: detail.vendor ?? null,
  };
}

/**
 * Load the public marketplace detail for the in-app extension-detail modal, as
 * a discriminated result so the modal renders content / not-found / error
 * without a thrown server-action crash. Anonymous public read (no bearer). The
 * CALLER is responsible for the admin gate — this is the shared fetch+project
 * seam (kept here so the marketplace client stays server-only + allowlisted).
 */
export async function loadPublicMarketplaceDetail(
  packageName: string,
): Promise<MarketplaceDetailLoadResult> {
  const name = typeof packageName === "string" ? packageName.trim() : "";
  if (!SCOPED_NPM_NAME_RE.test(name)) {
    return { ok: false, reason: "not_found" };
  }
  try {
    const detail = await fetchPublicMarketplaceExtensionDetail({ packageName: name });
    // Defense in depth: the public endpoint should only return public, listed
    // extensions; a non-public shape is treated as not-found (never rendered).
    if (detail.currentVisibility !== "public") {
      return { ok: false, reason: "not_found" };
    }
    return { ok: true, detail: toDetailView(name, detail) };
  } catch (err) {
    if (err instanceof MarketplaceMcpError && err.httpStatus === 404) {
      return { ok: false, reason: "not_found" };
    }
    const status = (err as { status?: number; statusCode?: number }).status
      ?? (err as { statusCode?: number }).statusCode;
    if ((err as { code?: string }).code === "E404" || status === 404) {
      return { ok: false, reason: "not_found" };
    }
    return { ok: false, reason: "error" };
  }
}
