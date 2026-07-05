import type { Metadata } from "next";
import { Loader2 } from "lucide-react";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Button } from "@/components/ui/button";
import type { ExtensionAccent } from "@/lib/extension-accent";
import {
  MarketplaceListingCard,
  type MarketplaceCardData,
} from "@cinatra-ai/extensions/screens";

export const metadata: Metadata = {
  title: "Marketplace Card Fixtures — Cinatra",
  description:
    "Internal route rendering the design spec §IV marketplace ListingCard with seeded fixtures — one card per six-state CTA state.",
};

// ---------------------------------------------------------------------------
// /design-fixtures/marketplace — the §IV "Extensions" ListingCard fixture grid
// (cinatra#988).
//
// STATIC (no DB, no auth, no marketplace fetch): renders the REAL
// MarketplaceListingCard — the exact component the live
// /configuration/marketplace screen composes — over seeded catalog fixtures,
// one card per six-state CTA state (Install now / Installed / Update now /
// Restore / Installing… / Incompatible). The CTA controls here are INERT
// visual lookalikes of the live controls (the live screen binds server-action
// forms, which need a DB); everything else on the card is the production code
// path. Seeded coverage demanded by the issue: display_name ≠ package_name on
// every card, a hosted icon URL on one card, an unsatisfiable sdkAbiRange on
// the Incompatible card, and all six CTA states.
//
// Verified by tests/e2e/design/marketplace-listing-card.spec.ts (structure
// assertions + the close-proof screenshots), which boots the standalone
// production build exactly like the /design-fixtures pixel gate.
// ---------------------------------------------------------------------------

// 1×1 blue PNG, inlined so the icon-tile <img> path renders deterministically
// with zero network dependence (the live card receives a sanitized hosted
// raster URL from the marketplace).
const FIXTURE_ICON_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkqK7+DwAChAGAdTUXpwAAAABJRU5ErkJggg==";

type FixtureSpec = {
  card: MarketplaceCardData;
  /** Pinned to accents present in the current palette (never the primary
   * action indigo nor the muted slate — the wrong-token regression class). */
  accent: ExtensionAccent;
  label: string;
  cta: React.ReactNode;
};

function fixtureCard(over: Partial<MarketplaceCardData>): MarketplaceCardData {
  return {
    packageName: "@cinatra-fixtures/research-assistant",
    packageVersion: "1.4.0",
    displayName: "Research Assistant",
    description:
      "Gathers sources, summarises, and cites answers across your team's docs.",
    kindSlug: "agent",
    kindLabel: "Agent",
    badge: { text: "Open source", variant: "oss" },
    freshnessAt: "2026-06-20T00:00:00Z",
    rating: { average: 4.8, count: 312 },
    detailHref: "/configuration/marketplace/cinatra-fixtures/research-assistant",
    installCount: 2100,
    iconUrl: null,
    vendorLogoUrl: null,
    sdkAbiRange: "*",
    vendor: { name: "Cinatra", storeUrl: "https://marketplace.cinatra.ai/store/cinatra" },
    ...over,
  };
}

/** Inert lookalike of the centred underlined "More details" modal trigger. */
function DetailsLookalike() {
  return (
    <Button size="sm" variant="link" className="underline">
      More details
    </Button>
  );
}

const FIXTURES: FixtureSpec[] = [
  {
    label: "Install · available",
    accent: "red",
    card: fixtureCard({}),
    cta: <Button size="sm">Install now</Button>,
  },
  {
    label: "Installed · current version",
    accent: "green",
    card: fixtureCard({
      packageName: "@cinatra-fixtures/pdf-extractor",
      displayName: "PDF Extractor",
      description:
        "Pulls structured tables, key/value fields and line items out of any PDF, scanned document or image — ready to map straight into your team's workflow.",
      kindSlug: "skill",
      kindLabel: "Skill",
      badge: { text: "Free", variant: "free" },
      rating: { average: 4.6, count: 124 },
      installCount: 880,
      freshnessAt: "2026-06-30T00:00:00Z",
      vendor: { name: "Foundry", storeUrl: "https://marketplace.cinatra.ai/store/foundry" },
      iconUrl: FIXTURE_ICON_DATA_URI,
    }),
    cta: (
      <Button size="sm" variant="secondary" disabled className="disabled:opacity-90">
        Installed
      </Button>
    ),
  },
  {
    label: "Update · newer in catalog",
    accent: "burgundy",
    card: fixtureCard({
      packageName: "@cinatra-fixtures/revenue-pulse",
      displayName: "Revenue Pulse",
      description:
        "Live revenue, churn and pipeline metrics on one board, refreshed every few minutes straight from your billing and CRM systems.",
      kindSlug: "workflow",
      kindLabel: "Workflow",
      badge: { text: "$9/mo", variant: "price" },
      rating: { average: 4.9, count: 208 },
      installCount: 1400,
      freshnessAt: "2026-06-28T00:00:00Z",
      vendor: { name: "Northstar", storeUrl: "https://marketplace.cinatra.ai/store/northstar" },
    }),
    cta: <Button size="sm">Update now</Button>,
  },
  {
    label: "Restore · was removed",
    accent: "green",
    card: fixtureCard({
      packageName: "@cinatra-fixtures/enterprise-kb-connector",
      displayName:
        "Enterprise Knowledge Base Connector for Confluence, Notion & SharePoint",
      description:
        "Indexes and unifies every page, doc and comment across Confluence, Notion and SharePoint into a single retrieval layer your agents and skills can query.",
      kindSlug: "connector",
      kindLabel: "Connector",
      badge: { text: "Free", variant: "free" },
      rating: { average: 4.3, count: 57 },
      installCount: 3200,
      freshnessAt: "2026-07-04T00:00:00Z",
      vendor: { name: "Meridian Labs", storeUrl: null },
    }),
    cta: (
      <Button size="sm" variant="outline">
        Restore
      </Button>
    ),
  },
  {
    label: "Installing · submit pending",
    accent: "burgundy",
    card: fixtureCard({
      packageName: "@cinatra-fixtures/quarterly-board-deck",
      displayName: "Quarterly Board Deck",
      description:
        "A board-ready deck that assembles itself from your metrics, narrative and risks each quarter — export to slides or share a live link.",
      kindSlug: "artifact",
      kindLabel: "Artifact",
      badge: { text: "$12", variant: "price" },
      rating: { average: 4.7, count: 96 },
      installCount: 640,
      freshnessAt: "2026-07-02T00:00:00Z",
      vendor: { name: "Vantage", storeUrl: "https://marketplace.cinatra.ai/store/vantage" },
    }),
    // Mirrors MarketplaceInstallSubmit's useFormStatus pending branch
    // (disabled + spinner + label) — the transient state a static fixture
    // cannot hold via a real form submission.
    cta: (
      <Button size="sm" disabled>
        <Loader2 className="animate-spin" aria-hidden="true" />
        Installing…
      </Button>
    ),
  },
  {
    label: "Incompatible · needs newer Cinatra",
    accent: "red",
    card: fixtureCard({
      packageName: "@cinatra-fixtures/meeting-summariser",
      displayName: "Meeting Summariser",
      description:
        "Turns call recordings into shareable notes — decisions, action items and owners — and drops them where your team already works.",
      kindSlug: "agent",
      kindLabel: "Agent",
      rating: { average: 4.5, count: 430 },
      installCount: 5600,
      freshnessAt: "2026-07-03T00:00:00Z",
      // Unsatisfiable on any current host ABI → deriveExtensionCompatState
      // yields "incompatible": red-triangle badge + greyed CTA.
      sdkAbiRange: "^999.0.0",
      vendor: { name: "Cinatra", storeUrl: "https://marketplace.cinatra.ai/store/cinatra" },
    }),
    cta: (
      <Button
        size="sm"
        disabled
        className="cursor-not-allowed disabled:pointer-events-auto disabled:opacity-40"
        title="Requires a newer Cinatra version"
      >
        Install now
      </Button>
    ),
  },
];

export default function MarketplaceCardFixturesPage() {
  return (
    <Main className="min-h-screen">
      <PageHeader
        label="Design system"
        title="Marketplace listing cards (§IV)"
        description="Internal — the §IV ListingCard over seeded fixtures, one card per six-state CTA state. CTA controls are inert lookalikes; the card anatomy is the production component."
      />
      <PageContent className="pb-12">
        <div
          data-testid="marketplace-card-grid"
          className="grid auto-rows-fr grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {FIXTURES.map((f) => (
            <div key={f.card.packageName} className="flex h-full flex-col gap-2">
              <div className="font-mono text-badge-xs font-bold uppercase tracking-widest text-muted-foreground">
                {f.label}
              </div>
              <MarketplaceListingCard
                card={f.card}
                accentColor={f.accent}
                ctaControl={f.cta}
                detailsControl={<DetailsLookalike />}
                className="flex-1"
              />
            </div>
          ))}
        </div>
      </PageContent>
    </Main>
  );
}
