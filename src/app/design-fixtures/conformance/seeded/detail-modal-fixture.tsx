"use client";

// ---------------------------------------------------------------------------
// extension-detail-modal conformance fixture (cinatra#986).
//
// Mounts the REAL §V MarketplaceDetailModal (same deep-import convention as
// the §V fixture route, cinatra#989) with:
//   - an injected detail loader resolving the deterministic seed (the same
//     substitution the §V fixture route documents — the storefront fetch is
//     the only replaced binding),
//   - the REAL footer-CTA state machinery: the CTA is re-derived by the REAL
//     resolveMarketplaceCardCta after the harness install action mutates the
//     installed-state input (the cinatra#985 card-harness pattern), so
//     "install → installed" is asserted through the real state machine.
//
// Anti-lookalike: SEEDED_MODAL_FIXTURE.displayName shares no token with its
// packageName, so a title bound to the package slug is a RED.
// ---------------------------------------------------------------------------

import { MarketplaceDetailModal } from "@cinatra-ai/extensions/screens/marketplace-detail-modal";
import {
  resolveMarketplaceCardCta,
  type MarketplaceCardData,
} from "@cinatra-ai/extensions/screens/marketplace-card-model";
import type {
  MarketplaceDetailLoadResult,
  MarketplaceDetailView,
} from "@/lib/marketplace-detail-view";
import { emptyRatingSummary } from "@/lib/marketplace-detail-view";
import { deriveExtensionCompatState } from "@/lib/extension-compat-badge";

import { useState } from "react";

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
  // The REAL installed-state input shape; mutated by the harness install
  // action so the REAL resolver re-derives the footer CTA (→ "Installed").
  const [installed, setInstalled] = useState<
    { version: string; isArchived: boolean } | undefined
  >(undefined);
  const compatState = deriveExtensionCompatState(CARD.sdkAbiRange);
  const cta = resolveMarketplaceCardCta(CARD, installed, true, compatState);

  const installAction = async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    setInstalled({ version: CARD.packageVersion, isArchived: false });
  };

  return (
    <div
      data-surface-id="extension-detail-modal"
      data-installed-version={installed?.version ?? ""}
      className="w-40"
    >
      <MarketplaceDetailModal
        card={CARD}
        cta={cta}
        installAction={installAction}
        updateAction={installAction}
        restoreAction={installAction}
        loadDetail={async (): Promise<MarketplaceDetailLoadResult> => ({
          ok: true,
          detail: DETAIL,
        })}
      />
    </div>
  );
}
