import "server-only";

import { getConnectorRegistryEntryBySlug, type ConnectorRegistryEntry } from "@/lib/connectors-registry.server";
import { enforceConnectorPolicy } from "@/lib/connector-policy";
import { resolveRuntimeConnectorCardRecord } from "@/lib/extension-install-resolution";
import type { ActorContext } from "@/lib/authz/actor-context";

type ConnectorRouteResolution =
  | {
      kind: "identity";
      packageId: string;
      displayName: string;
      isCatalog: boolean;
      catalogEntry: ConnectorRegistryEntry | undefined;
    }
  | { kind: "refused"; considerMarketplaceRedirect: boolean };

/** Shared by metadata and the page; preserves the page's catalog/trust gates. */
export async function resolveConnectorRouteIdentity(
  { vendor, slug, subroute }: { vendor: string; slug: string; subroute: string },
  actor: ActorContext | null | undefined,
): Promise<ConnectorRouteResolution> {
  const catalogEntry = getConnectorRegistryEntryBySlug(slug);
  if (catalogEntry) {
    if (catalogEntry.vendor !== vendor || catalogEntry.setupSubroute !== subroute) {
      return { kind: "refused", considerMarketplaceRedirect: false };
    }
    const decision = enforceConnectorPolicy(catalogEntry.packageId, actor ?? undefined, "read");
    if (!decision.allowed) return { kind: "refused", considerMarketplaceRedirect: false };
    return {
      kind: "identity",
      packageId: catalogEntry.packageId,
      displayName: catalogEntry.displayName,
      isCatalog: true,
      catalogEntry,
    };
  }

  // This resolver admits only an actor-addressable, trusted runtime install.
  // The catalog policy cannot admit no-catalog packages; do not weaken it.
  const packageId = `@${vendor}/${slug}`;
  const card = await resolveRuntimeConnectorCardRecord(packageId, actor ?? undefined);
  if (!card || card.vendor !== vendor || card.slug !== slug) {
    return { kind: "refused", considerMarketplaceRedirect: true };
  }
  if (subroute !== "setup") return { kind: "refused", considerMarketplaceRedirect: false };
  return {
    kind: "identity",
    packageId,
    displayName: card.displayName,
    isCatalog: false,
    catalogEntry: undefined,
  };
}
