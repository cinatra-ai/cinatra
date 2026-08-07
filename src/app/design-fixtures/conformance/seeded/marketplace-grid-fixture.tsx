// ---------------------------------------------------------------------------
// extension-listing-grid conformance fixture (cinatra#986).
//
// SERVER component mirroring the real composition exactly: the server builds
// the card nodes (REAL MarketplaceListingCard) and hands them, with their
// filter metadata, to the REAL ExtensionsMarketplaceClient — the same
// server/client split ExtensionsMarketplaceScreen uses. The card CTAs are
// INERT here (per-card CTA behavior is covered by the
// extension-listing-card-* surfaces on /design-fixtures/conformance), but
// each card renders a DIFFERENT six-state CTA identity at rest — one card per
// state, assigned in seed-data.ts (cinatra#2363 item 2) — mirroring the
// presentation of the real controls (labels, variants, the pending spinner)
// so the production-density grid composition exercises every CTA label,
// including the long "Installing…" one the wrap contract is written around.
// The GRID conformance surface itself still asserts cardinality + the
// empty/loading state variants; the per-state geometry is measured by
// tests/e2e/design/marketplace-listing-card-geometry.spec.ts.
// ---------------------------------------------------------------------------

// Deep module imports ON PURPOSE (cinatra#985 convention): the screens barrel
// re-exports the registry-catalog SERVER screen; the client component below
// must be imported through its client-safe module.
import { ExtensionsMarketplaceClient } from "@cinatra-ai/extensions/screens/extensions-marketplace-client";
import { MarketplaceListingCard } from "@cinatra-ai/extensions/screens/marketplace-listing-card";
import type { MarketplaceCardData } from "@cinatra-ai/extensions/screens/marketplace-card-model";
import {
  deriveIconSlug,
  safeManifestLogoSrc,
} from "@cinatra-ai/extensions/screens/marketplace-card-model";

import { Loader2 } from "lucide-react";

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
    // cinatra#2469: the extension's OWN sanitized `cinatra.logo` — the value
    // STATIC_EXTENSION_MANIFEST carries for a package that declares one.
    //
    // Both fields go through the SAME functions the production mapper
    // (`catalogEntryToCardData`) applies, rather than being hand-assigned: the
    // guard `safeManifestLogoSrc` must admit the value, and the client-icon slug
    // is DERIVED from the package name for every kind. So a regression in either
    // — a tightened guard that rejects real generator output, or broken slug
    // derivation — fails the seeded harness instead of sailing past it. What
    // stays outside this fixture is the loader hop that feeds the
    // real screen (STATIC_EXTENSION_MANIFEST → manifestLogoForPackage); the
    // storefront catalog is an HTTP source, so the harness supplies the entry
    // exactly as the real screen's own composition does.
    manifestLogoUrl: safeManifestLogoSrc(seed.manifestLogoUrl ?? null),
    iconSlug: deriveIconSlug(seed.packageName),
    iconUrl: null,
    vendorLogoUrl: null,
    // The incompatible-state card declares an unsatisfiable ABI range so its
    // compat meta row agrees with its greyed CTA (same derivation the real
    // screen and the per-surface harness use).
    sdkAbiRange: seed.ctaState === "incompatible" ? ">=999.0.0" : "*",
    vendor: { name: "Cinatra Fixtures", storeUrl: null },
  };
}

/**
 * Inert per-state CTA control mirroring the REAL six-state presentation
 * (extensions-marketplace-screen.tsx / card-fixtures.tsx branches): same
 * labels, same variants, same disabled treatments — the "installing" card
 * mirrors MarketplaceInstallSubmit's pending presentation (spinner +
 * pending label + `disabled:opacity-70` + `data-pending`) at rest.
 */
function inertCtaControl(seed: SeededGridCard) {
  const title = "Grid fixture — CTA behavior is covered by the extension-listing-card-* surfaces";
  switch (seed.ctaState) {
    case "installed":
      return (
        <Button size="sm" variant="secondary" disabled className="disabled:opacity-90" title={title}>
          {seed.ctaLabel}
        </Button>
      );
    case "restore":
      return (
        <Button size="sm" variant="outline" disabled title={title}>
          {seed.ctaLabel}
        </Button>
      );
    case "installing":
      return (
        <Button size="sm" disabled data-pending="" className="disabled:opacity-70" title={title}>
          <Loader2 className="animate-spin" aria-hidden="true" />
          {seed.ctaLabel}
        </Button>
      );
    case "incompatible":
      return (
        <Button
          size="sm"
          disabled
          className="cursor-not-allowed disabled:pointer-events-auto disabled:opacity-40"
          title="Requires a newer Cinatra version"
        >
          {seed.ctaLabel}
        </Button>
      );
    case "install":
    case "update":
      return (
        <Button size="sm" disabled title={title}>
          {seed.ctaLabel}
        </Button>
      );
  }
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
          ctaControl={inertCtaControl(seed)}
          ctaState={seed.ctaState}
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
