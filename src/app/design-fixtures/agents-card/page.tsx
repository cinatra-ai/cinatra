import type { Metadata } from "next";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";

import { AgentsCardAccentFixtures } from "./agents-card-fixtures";

export const metadata: Metadata = {
  title: "Design Fixtures — Agents card accent hotspot — Cinatra",
  description:
    "Internal route rendering the /agents All-Agents card so the coloured accent-panel → detail-modal interaction (cinatra#1121) is verifiable on a production-equivalent build.",
};

/**
 * /design-fixtures/agents-card.
 *
 * Internal route. Not linked from navigation. Renders the real AgentAllCard so
 * the accent-panel-as-detail-hotspot (cinatra#1121) is assertion-verifiable
 * (tests/e2e/design/agents-card-accent.spec.ts) without a session or storefront
 * round-trip. Kept OFF the pixel-diffed /design-fixtures index page so the
 * committed baselines there stay untouched; the Playwright coverage for this
 * route is assertion-based.
 */
export default function AgentsCardAccentFixturesPage() {
  return (
    <Main className="min-h-screen">
      <PageHeader
        label="Design system"
        title="Agents card — accent hotspot fixtures"
        description="Internal — the /agents All-Agents card: the coloured accent panel is a pointer-cursor click target that opens the detail modal in place; the inert row (no listing) shows Run only."
      />
      <PageContent className="flex flex-col gap-8 pb-12">
        <AgentsCardAccentFixtures />
      </PageContent>
    </Main>
  );
}
