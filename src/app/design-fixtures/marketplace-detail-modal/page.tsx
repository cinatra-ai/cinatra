import type { Metadata } from "next";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";

import { MarketplaceDetailModalFixtures } from "./modal-fixtures";

export const metadata: Metadata = {
  title: "Design Fixtures — Extension detail modal — Cinatra",
  description:
    "Internal route rendering the §V extension-detail modal against seeded detail fixtures (populated / empty states: specs column, changelog, dependencies, reviews).",
};

/**
 * /design-fixtures/marketplace-detail-modal.
 *
 * Internal route. Not linked from navigation. Renders the real
 * `MarketplaceDetailModal` component against seeded `MarketplaceDetailView`
 * fixtures so the §V "Extension detail (modal)" surface (cinatra#989: Changelog
 * tab, Dependencies section, plain "Compatible up to" specs row, chrome/header
 * tokens) is verifiable on a production-equivalent build without a storefront
 * round-trip — the live storefront does not serve
 * changelog/dependencies/compatibleUpTo yet (marketplace#190). Per the §V
 * drawing the modal renders NO banner or coloured ground (the hosted-banner
 * premise on #739 was a diagnosis error, not spec).
 *
 * Kept OFF the pixel-diffed /design-fixtures index page so the committed
 * baselines there stay untouched; the Playwright coverage for this route is
 * assertion-based (tests/e2e/design/marketplace-detail-modal.spec.ts).
 *
 * Operational source: the design-system reference §V at
 * https://docs.cinatra.ai/references/design/design-system.html.
 */
export default function MarketplaceDetailModalFixturesPage() {
  return (
    <Main className="min-h-screen">
      <PageHeader
        label="Design system"
        title="Extension detail modal fixtures"
        description="Internal — the §V detail modal against seeded detail payloads: populated specs/changelog/dependencies/reviews, and the graceful empty states."
      />
      <PageContent className="flex flex-col gap-8 pb-12">
        <MarketplaceDetailModalFixtures />
      </PageContent>
    </Main>
  );
}
