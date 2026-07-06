// ---------------------------------------------------------------------------
// extension-listing-grid conformance fixture (cinatra#986).
//
// SERVER component mirroring the real composition exactly: the server builds
// the card nodes (REAL MarketplaceListingCard) and hands them, with their
// filter metadata, to the REAL ExtensionsMarketplaceClient — the same
// server/client split ExtensionsMarketplaceScreen uses. The card CTA is an
// inert placeholder here (per-card CTA behavior is covered by the
// extension-listing-card-* surfaces on /design-fixtures/conformance); the
// GRID surface asserts cardinality + the empty/loading state variants.
// ---------------------------------------------------------------------------

// Deep module imports ON PURPOSE (cinatra#985 convention): the screens barrel
// re-exports the registry-catalog SERVER screen; the client component below
// must be imported through its client-safe module.
import { ExtensionsMarketplaceClient } from "@cinatra-ai/extensions/screens/extensions-marketplace-client";
import { MarketplaceListingCard } from "@cinatra-ai/extensions/screens/marketplace-listing-card";
import type { MarketplaceCardData } from "@cinatra-ai/extensions/screens/marketplace-card-model";

import { Button } from "@/components/ui/button";
import { deriveExtensionAccent } from "@/lib/extension-accent";

import { SEEDED_GRID_CARDS, type SeededGridCard } from "../seed-data";

function toCardData(seed: SeededGridCard): MarketplaceCardData {
  return {
    packageName: seed.packageName,
    packageVersion: seed.packageVersion,
    displayName: seed.displayName,
    description: seed.description,
    kindSlug: seed.kindSlug,
    kindLabel: seed.kindLabel,
    badge: { text: "Free", variant: "free" },
    freshnessAt: null,
    rating: null,
    detailHref: `/configuration/marketplace/fixtures/${seed.packageName.split("/")[1]}`,
    installCount: null,
    iconUrl: null,
    vendorLogoUrl: null,
    sdkAbiRange: "*",
    vendor: { name: "Cinatra Fixtures", storeUrl: null },
  };
}

function gridCards() {
  return SEEDED_GRID_CARDS.map((seed) => {
    const card = toCardData(seed);
    return {
      meta: {
        packageName: card.packageName,
        title: card.displayName,
        description: card.description,
        kind: card.kindSlug,
      },
      node: (
        <MarketplaceListingCard
          card={card}
          accentColor={deriveExtensionAccent(card.packageName)}
          ctaControl={
            <Button size="sm" disabled title="Grid fixture — CTA behavior is covered by the extension-listing-card-* surfaces">
              Install now
            </Button>
          }
          ctaState="install"
          detailsControl={
            <Button type="button" variant="link" size="sm">
              More details
            </Button>
          }
        />
      ),
    };
  });
}

export function MarketplaceGridFixture({ populated }: { populated: boolean }) {
  return <ExtensionsMarketplaceClient cards={populated ? gridCards() : []} />;
}

/**
 * The ?variant=loading instance: a deliberately slow async card source under
 * the page's Suspense boundary, so the REAL fallback
 * (MarketplaceGridLoadingFallback — the same component the marketplace screen
 * renders) is observable mid-stream on the production standalone boot.
 */
export async function DelayedMarketplaceGridFixture() {
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  return <ExtensionsMarketplaceClient cards={gridCards()} />;
}
