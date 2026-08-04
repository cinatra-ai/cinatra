// ---------------------------------------------------------------------------
// extension-listing-grid conformance fixture (cinatra#986).
//
// SERVER component mirroring the real composition exactly: the server builds
// the card nodes (REAL MarketplaceListingCard) and hands them, with their
// filter metadata, to the REAL ExtensionsMarketplaceClient — the same
// server/client split ExtensionsMarketplaceScreen uses. The card CTAs are
// inert here (per-card CTA BEHAVIOR is covered by the
// extension-listing-card-* surfaces on /design-fixtures/conformance); the
// GRID surface asserts cardinality + the empty/loading state variants.
//
// Inert, but no longer uniform (cinatra#2363): the six seeded cards carry the
// six CTA states' real LABELS and variants, one each. Before, every card said
// "Install now", so the widest control in the set ("Installing…" with its
// spinner) never appeared beside "More details" anywhere in this grid at all —
// the real 1/sm:2/lg:3/xl:4 composition was only ever exercised against the
// narrowest label. Behaviour stays inert: every control is `disabled`, no form
// is mounted, and `ctaState` still reports the state the card is presenting,
// so `data-cta-state` remains truthful.
//
// NOT a geometry surface, deliberately: this page mounts the grid inside a
// `CardContent`, which insets it ~17px per side relative to the live screen.
// The bounding-box contract is measured on /design-fixtures/conformance, whose
// listing-card section is mounted bare inside PageContent precisely so its
// widths equal the live ones (tests/e2e/design/extension-card-action-row.spec.ts).
// What this fixture adds is REAL-COMPOSITION coverage of the six states —
// server-built card nodes handed to the real client — not pixel evidence.
// ---------------------------------------------------------------------------

// Deep module imports ON PURPOSE (cinatra#985 convention): the screens barrel
// re-exports the registry-catalog SERVER screen; the client component below
// must be imported through its client-safe module.
import { ExtensionsMarketplaceClient } from "@cinatra-ai/extensions/screens/extensions-marketplace-client";
import { MarketplaceListingCard } from "@cinatra-ai/extensions/screens/marketplace-listing-card";
import type { MarketplaceCardData } from "@cinatra-ai/extensions/screens/marketplace-card-model";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { deriveExtensionAccent } from "@/lib/extension-accent";

import { SEEDED_GRID_CARDS, type SeededGridCard } from "../seed-data";

/**
 * The six CTA presentations, in the spec's own §I order, one per seeded card.
 * Each entry reproduces the label + Button variant the REAL control renders in
 * that state — the pending entry additionally carrying the spinner
 * `MarketplaceInstallSubmit` shows beside its busy label, because that pairing
 * is what makes "Installing…" the widest control in the set and therefore the
 * one the geometry contract actually turns on.
 *
 * Presentation ONLY: no form, no action, every control disabled. The behaviour
 * of each state is owned by the extension-listing-card-* surfaces, which drive
 * the real resolver and the real form.
 */
type GridCtaPresentation = {
  state: string;
  label: string;
  variant?: "secondary" | "outline";
  /** Busy state: spinner + 70% opacity, as `MarketplaceInstallSubmit` renders. */
  pending?: boolean;
  /** Blocked state: 40% opacity + not-allowed cursor, as the real control does. */
  blocked?: boolean;
};

const GRID_CTA_PRESENTATIONS: readonly GridCtaPresentation[] = [
  { state: "install", label: "Install now" },
  { state: "installed", label: "Installed", variant: "secondary" },
  { state: "update", label: "Update now" },
  { state: "restore", label: "Restore", variant: "outline" },
  { state: "installing", label: "Installing…", pending: true },
  { state: "incompatible", label: "Install now", blocked: true },
];

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
    manifestLogoUrl: null,
    iconSlug: null,
    iconUrl: null,
    vendorLogoUrl: null,
    sdkAbiRange: "*",
    vendor: { name: "Cinatra Fixtures", storeUrl: null },
  };
}

function gridCards() {
  return SEEDED_GRID_CARDS.map((seed, index) => {
    const card = toCardData(seed);
    // One state per seeded card, cycling if the seed list ever outgrows the
    // six presentations (it is exactly six today, so every state appears once).
    const cta = GRID_CTA_PRESENTATIONS[index % GRID_CTA_PRESENTATIONS.length];
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
            <Button
              size="sm"
              variant={cta.variant}
              disabled
              // The busy state's 70% opacity and the blocked state's 40% are
              // the real controls' own treatments; without them the inert
              // stand-ins would read as ordinary disabled buttons.
              className={
                cta.pending
                  ? "disabled:opacity-70"
                  : cta.blocked
                    ? "cursor-not-allowed disabled:pointer-events-auto disabled:opacity-40"
                    : undefined
              }
              title="Grid fixture — CTA behavior is covered by the extension-listing-card-* surfaces"
            >
              {cta.pending && <Loader2 className="animate-spin" aria-hidden="true" />}
              {cta.label}
            </Button>
          }
          ctaState={cta.state}
          detailsControl={
            // Same classes as the LIVE §IV trigger (marketplace-detail-modal.tsx),
            // so this grid renders the real control's width.
            <Button type="button" variant="link" size="sm" className="px-1 underline">
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
