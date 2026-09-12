import "server-only";

import {
  getConnectorRegistryEntryBySlug,
  type ConnectorRegistryEntry,
} from "@/lib/connectors-registry.server";
import { enforceConnectorPolicy } from "@/lib/connector-policy";
import { resolveRuntimeConnectorCardRecord } from "@/lib/extension-install-resolution";
import type { ActorContext } from "@/lib/authz/actor-context";

/**
 * THE CONNECTOR DISPATCH ROUTE'S RESOLVED IDENTITY (cinatra#3235).
 *
 * The route's `generateMetadata` used to resolve the connector through the
 * static catalog ALONE and title the page around the root template, so a
 * trusted runtime-only connector — one the page itself renders through the
 * runtime card record — got a "Not found" title on a page that is not a
 * not-found page, and every connector's server-rendered tab title carried a
 * doubled suffix. The tab title has to read ONE identity, so the metadata and
 * the page body resolve the SAME one: this module is that resolution, lifted
 * out of the route body verbatim, and both callers ask it.
 *
 * Fail-closed, in the body's own order: a vendor, slug or subroute the page
 * would refuse resolves to a refusal here too, and the refusal says whether
 * the body had reached the point where it evaluates the narrow
 * marketplace-redirect decision (cinatra#1529) — that decision stays in the
 * route, which owns `redirect()`.
 */

export type ConnectorRouteIdentity = {
  readonly kind: "identity";
  readonly packageId: string;
  readonly displayName: string;
  readonly isCatalog: boolean;
  /** The catalog descriptor on the catalog path; undefined on the runtime path. */
  readonly catalogEntry: ConnectorRegistryEntry | undefined;
};

export type ConnectorRouteRefusal = {
  readonly kind: "refused";
  /**
   * True ONLY at the one place the route body evaluates the marketplace
   * redirect: the runtime-only path with no trusted, addressable install. Every
   * other refusal is the 404 the body emitted directly.
   */
  readonly considerMarketplaceRedirect: boolean;
};

export type ConnectorRouteResolution =
  | ConnectorRouteIdentity
  | ConnectorRouteRefusal;

/** The subroute a runtime-only connector's setup page answers on. */
const RUNTIME_CONNECTOR_SETUP_SUBROUTE = "setup";

/** The title a refused vendor, slug or subroute carries. */
export const CONNECTOR_ROUTE_NOT_FOUND_TITLE = "Not found";

export async function resolveConnectorRouteIdentity(
  params: { vendor: string; slug: string; subroute: string },
  actor: ActorContext | undefined | null,
): Promise<ConnectorRouteResolution> {
  const { vendor, slug, subroute } = params;
  // Resolve the connector by slug, then require the vendor segment to match its
  // manifest-resolved identity (installed-extension scope) — no hardcoded
  // vendor handling. A connector with a build-time CATALOG descriptor takes the
  // catalog path; a purely RUNTIME-installed connector with NO catalog
  // descriptor takes the runtime-only fallback (cinatra#658 Track 2).
  const catalogEntry = getConnectorRegistryEntryBySlug(slug);

  if (catalogEntry) {
    if (catalogEntry.vendor !== vendor) {
      return { kind: "refused", considerMarketplaceRedirect: false };
    }
    if (subroute !== catalogEntry.setupSubroute) {
      return { kind: "refused", considerMarketplaceRedirect: false };
    }
    // Catalog policy gate (unchanged): canonical-first → legacy fallback.
    const decision = enforceConnectorPolicy(
      catalogEntry.packageId,
      actor ?? undefined,
      "read",
    );
    if (!decision.allowed) {
      return { kind: "refused", considerMarketplaceRedirect: false };
    }
    return {
      kind: "identity",
      packageId: catalogEntry.packageId,
      displayName: catalogEntry.displayName,
      isCatalog: true,
      catalogEntry,
    };
  }

  // RUNTIME-ONLY fallback. `enforceConnectorPolicy` denies a no-catalog package
  // (`unknown_connector`) BEFORE any canonical check, so we CANNOT reach the
  // runtime surface through it. Instead, resolve the trusted runtime card
  // record: it runs the FULL trust gate (actor has an active canonical install
  // in scope → anchor → integrity → signature → trust). A non-null result is
  // therefore BOTH proof of trust AND of actor authorization for this install.
  const packageName = `@${vendor}/${slug}`;
  const cardRecord = await resolveRuntimeConnectorCardRecord(packageName, actor);
  // Fail closed: no trusted+addressable runtime install → refused (never leak
  // existence to an unauthorized/cross-org actor). This is the one refusal the
  // route body follows with the narrow marketplace-redirect decision.
  if (!cardRecord || cardRecord.vendor !== vendor || cardRecord.slug !== slug) {
    return { kind: "refused", considerMarketplaceRedirect: true };
  }
  // A runtime-only connector reaches its setup route only via the
  // schema-config surface (it ships no base-image React loader). Reuse the
  // catalog setup subroute convention ("setup").
  if (subroute !== RUNTIME_CONNECTOR_SETUP_SUBROUTE) {
    return { kind: "refused", considerMarketplaceRedirect: false };
  }
  return {
    kind: "identity",
    packageId: packageName,
    displayName: cardRecord.displayName,
    isCatalog: false,
    catalogEntry: undefined,
  };
}

/**
 * The route's own title string — the connector's server-authorized display
 * name, or the not-found title on any refusal. Returned BARE so the root
 * layout's `"%s | Cinatra"` template composes it once: the effective rendered
 * title is the display name followed by exactly one " | Cinatra", the same
 * string the shell's trail mirror writes after hydration.
 */
export function connectorRouteTitle(
  resolution: ConnectorRouteResolution,
): string {
  return resolution.kind === "identity"
    ? resolution.displayName
    : CONNECTOR_ROUTE_NOT_FOUND_TITLE;
}
