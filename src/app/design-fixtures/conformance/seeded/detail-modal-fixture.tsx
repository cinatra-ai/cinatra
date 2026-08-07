"use client";

// ---------------------------------------------------------------------------
// extension-detail-modal conformance fixture (cinatra#986).
//
// Mounts the REAL §V MarketplaceDetailModal (same deep-import convention as
// the §V fixture route, cinatra#989) with an injected detail loader resolving
// the deterministic seed (the same substitution the §V fixture route
// documents — the storefront fetch is the only replaced binding).
//
// cinatra#2406 (owner ruling): the modal renders no footer anywhere in the
// app — details-only. The fixture no longer drives an install action or
// tracks an installed-state transition (there is no more footer CTA to
// re-derive through resolveMarketplaceCardCta).
//
// Anti-lookalike: SEEDED_MODAL_FIXTURE.displayName shares no token with its
// packageName, so a title bound to the package slug is a RED.
// ---------------------------------------------------------------------------

import { MarketplaceDetailModal } from "@cinatra-ai/extensions/screens/marketplace-detail-modal";
import type { MarketplaceCardData } from "@cinatra-ai/extensions/screens/marketplace-card-model";
import type {
  MarketplaceDetailLoadResult,
  MarketplaceDetailView,
} from "@/lib/marketplace-detail-view";
import { emptyRatingSummary } from "@/lib/marketplace-detail-view";

import { SEEDED_MODAL_FIXTURE } from "../seed-data";

const CARD: MarketplaceCardData = {
  packageName: SEEDED_MODAL_FIXTURE.packageName,
  packageVersion: SEEDED_MODAL_FIXTURE.packageVersion,
  displayName: SEEDED_MODAL_FIXTURE.displayName,
  description: SEEDED_MODAL_FIXTURE.description,
  kindSlug: SEEDED_MODAL_FIXTURE.kindSlug,
  kindLabel: SEEDED_MODAL_FIXTURE.kindLabel,
  badge: { text: "Free", variant: "free" },
  freshnessAt: null,
  rating: null,
  detailHref: "#",
  installCount: null,
  manifestLogoUrl: null,
  iconSlug: null,
  iconUrl: null,
  vendorLogoUrl: null,
  sdkAbiRange: "*",
  vendor: { name: SEEDED_MODAL_FIXTURE.vendorName, storeUrl: null },
};

const DETAIL: MarketplaceDetailView = {
  packageName: SEEDED_MODAL_FIXTURE.packageName,
  displayName: SEEDED_MODAL_FIXTURE.displayName,
  kindLabel: SEEDED_MODAL_FIXTURE.kindLabel,
  cost: "Free",
  license: "Apache-2.0",
  latestVersion: SEEDED_MODAL_FIXTURE.packageVersion,
  freshnessAt: "2026-06-30T12:00:00.000Z",
  installCount: 120,
  permalink: null,
  sdkAbiRange: null,
  readmeMarkdown: null,
  longDescription: null,
  description: SEEDED_MODAL_FIXTURE.description,
  iconUrl: null,
  compatibleUpTo: null,
  changelog: [],
  dependencies: [],
  ratingSummary: emptyRatingSummary(),
  reviews: [],
  vendor: { name: SEEDED_MODAL_FIXTURE.vendorName, slug: "cinatra-fixtures", storeUrl: null },
};

export function DetailModalConformanceFixture() {
  return (
    <div data-surface-id="extension-detail-modal" className="w-40">
      <MarketplaceDetailModal
        card={CARD}
        loadDetail={async (): Promise<MarketplaceDetailLoadResult> => ({
          ok: true,
          detail: DETAIL,
        })}
      />
    </div>
  );
}
