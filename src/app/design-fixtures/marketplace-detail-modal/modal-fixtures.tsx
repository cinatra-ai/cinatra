"use client";

// ---------------------------------------------------------------------------
// Seeded fixtures for the §V extension-detail modal (cinatra#989 + #739).
//
// Renders the REAL MarketplaceDetailModal with an injected loader that
// resolves a deterministic MarketplaceDetailView — no storefront round-trip,
// no registry, no DB. Three instances cover the §V evidence matrix:
//
//   1. banner-present  — hosted banner hero (scrim + accent ground), a
//      multi-version changelog with the "Latest" badge, declared
//      `cinatra.dependencies`, two reviews.
//   2. banner-absent   — plain §V hero fallback, "No changelog available"
//      empty state, none-declared dependencies (section omitted).
//   3. banner-blank    — bannerUrl === "" must behave exactly like absent.
//
// The banner asset is a committed raster under /public (the marketplace
// contract never serves raw SVG banners); the fixture bypasses the server
// projection, so it exercises the modal's own trim-guard + fallback path.
// ---------------------------------------------------------------------------

// Deep module import ON PURPOSE: the screens barrel re-exports the
// registry-catalog SERVER screen (pacote/child_process reach), which a client
// component page must never pull into the browser graph. The modal module
// itself is "use client" and client-safe. Type-only imports from the barrel
// are erased at compile time and are safe.
import { MarketplaceDetailModal } from "@cinatra-ai/extensions/screens/marketplace-detail-modal";
import type { MarketplaceCardData, MarketplaceCardCta } from "@cinatra-ai/extensions/screens";
import type {
  MarketplaceDetailLoadResult,
  MarketplaceDetailView,
} from "@/lib/marketplace-detail-view";
import { emptyRatingSummary } from "@/lib/marketplace-detail-view";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const BANNER_FIXTURE_URL = "/design-fixtures/marketplace-banner-fixture.png";

const RESEARCH_ASSISTANT_README = [
  "## Research Assistant",
  "",
  "Research Assistant gathers sources, summarises long documents and returns cited answers grounded in your team's own knowledge base — so every answer traces back to a document you can open.",
  "",
  "### Features",
  "",
  "- Multi-source retrieval across Confluence, Notion, Google Drive and uploaded files",
  "- Inline citations on every claim, linked back to the source passage",
  "- Follow-up questions that keep the working context",
  "",
  "### Usage",
  "",
  "Ask a question in natural language; the agent plans a retrieval, reads the top passages and drafts a cited answer.",
].join("\n");

/** Fixture 1 — banner present, changelog + dependencies populated. */
const BANNER_DETAIL: MarketplaceDetailView = {
  packageName: "@cinatra-ai/research-assistant-agent",
  displayName: "Research Assistant",
  kindLabel: "Agent",
  cost: "Free, Open Source",
  license: "Apache-2.0",
  latestVersion: "0.4.2",
  freshnessAt: "2026-06-28T12:00:00.000Z",
  installCount: 8000,
  permalink: "https://marketplace.cinatra.ai/product/research-assistant",
  sdkAbiRange: null,
  readmeMarkdown: RESEARCH_ASSISTANT_README,
  longDescription: null,
  description: "Gathers sources, summarises, and cites answers grounded in your team's own documents.",
  iconUrl: null,
  bannerUrl: BANNER_FIXTURE_URL,
  changelog: [
    {
      version: "0.4.2",
      date: "2026-06-28",
      notes: [
        "Inline citations now deep-link to the exact source passage.",
        "Faster multi-source retrieval across large Confluence and Notion workspaces.",
      ],
    },
    {
      version: "0.4.1",
      date: "2026-06-14",
      notes: [
        "Fixed Notion pagination dropping results past the first page.",
        "Follow-up questions now carry the full working context.",
      ],
    },
    {
      version: "0.4.0",
      date: "2026-05-05",
      notes: ["Initial release — multi-source retrieval with cited answers."],
    },
  ],
  dependencies: [
    {
      packageName: "@cinatra-ai/confluence-connector",
      name: "Confluence Connector",
      kind: "connector",
      versionRange: ">=1.2.0",
    },
    {
      packageName: "@cinatra-ai/pdf-extractor",
      name: "PDF Extractor",
      kind: "skill",
      versionRange: ">=0.4.0",
    },
  ],
  ratingSummary: {
    average: 4.5,
    total: 2,
    counts: { "1": 0, "2": 0, "3": 0, "4": 1, "5": 1 },
  },
  reviews: [
    {
      author: "Priya Nadar",
      verifiedOwner: true,
      date: "2026-06-21T09:00:00.000Z",
      rating: 5,
      text: "Cut our research turnaround in half. The citations are the killer feature — every answer links straight back to the source doc.",
    },
    {
      author: "Marcus Reed",
      verifiedOwner: false,
      date: "2026-06-05T09:00:00.000Z",
      rating: 4,
      text: "Solid retrieval across our Notion and Drive. Occasionally over-summarises, but the follow-up questions keep the thread.",
    },
  ],
  vendor: {
    name: "Cinatra",
    slug: "cinatra",
    storeUrl: "https://marketplace.cinatra.ai/store/cinatra",
  },
};

/** Fixture 2 — banner absent; changelog + dependencies empty states. */
const PLAIN_DETAIL: MarketplaceDetailView = {
  packageName: "@cinatra-ai/pdf-extractor",
  displayName: "PDF Extractor",
  kindLabel: "Skill",
  cost: "Free",
  license: null,
  latestVersion: "1.2.0",
  freshnessAt: "2026-06-10T12:00:00.000Z",
  installCount: 950,
  permalink: "https://marketplace.cinatra.ai/product/pdf-extractor",
  sdkAbiRange: null,
  readmeMarkdown: null,
  longDescription: null,
  description:
    "Pulls structured tables, key/value fields and line items out of any PDF, scanned document or image.",
  iconUrl: null,
  bannerUrl: null,
  changelog: [],
  dependencies: [],
  ratingSummary: emptyRatingSummary(),
  reviews: [],
  vendor: {
    name: "Foundry",
    slug: "foundry",
    storeUrl: "https://marketplace.cinatra.ai/store/foundry",
  },
};

/** Fixture 3 — bannerUrl BLANK ("") must fall back exactly like absent. */
const BLANK_BANNER_DETAIL: MarketplaceDetailView = {
  ...PLAIN_DETAIL,
  packageName: "@cinatra-ai/media-transcript-agent",
  displayName: "Media Transcript Agent",
  kindLabel: "Agent",
  description:
    "Transcribes audio or video URLs to text with speaker markers.",
  bannerUrl: "",
};

function cardFor(detail: MarketplaceDetailView, kindSlug: MarketplaceCardData["kindSlug"]): MarketplaceCardData {
  return {
    packageName: detail.packageName,
    packageVersion: detail.latestVersion ?? "0.0.0",
    displayName: detail.displayName,
    description: detail.description,
    kindSlug,
    kindLabel: detail.kindLabel,
    badge: null,
    freshnessAt: detail.freshnessAt,
    rating:
      detail.ratingSummary.total > 0
        ? { average: detail.ratingSummary.average, count: detail.ratingSummary.total }
        : null,
    detailHref: "#",
    installCount: detail.installCount,
    iconUrl: null,
    vendorLogoUrl: null,
    sdkAbiRange: detail.sdkAbiRange,
  };
}

// Deterministic, side-effect-free stand-ins for the bound server actions —
// the fixture footer renders the disabled "Install Now" state (no registry).
const CTA: MarketplaceCardCta = { state: "install", disabled: true };
const noopAction = async () => {};

const FIXTURES: Array<{
  testId: string;
  label: string;
  detail: MarketplaceDetailView;
  kindSlug: MarketplaceCardData["kindSlug"];
}> = [
  {
    testId: "modal-fixture-banner",
    label: "Banner present — changelog + dependencies populated",
    detail: BANNER_DETAIL,
    kindSlug: "agent",
  },
  {
    testId: "modal-fixture-plain",
    label: "Banner absent — empty changelog, none-declared dependencies",
    detail: PLAIN_DETAIL,
    kindSlug: "skill",
  },
  {
    testId: "modal-fixture-blank-banner",
    label: "Banner blank (\"\") — must fall back like absent",
    detail: BLANK_BANNER_DETAIL,
    kindSlug: "agent",
  },
];

export function MarketplaceDetailModalFixtures() {
  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardHeader>
        <CardTitle>§V extension detail modal — seeded detail payloads</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {FIXTURES.map((f) => (
          <div
            key={f.testId}
            data-testid={f.testId}
            className="flex items-center justify-between gap-4 rounded-card border border-line bg-surface-strong px-4 py-3"
          >
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">{f.detail.displayName}</p>
              <p className="text-xs text-muted-foreground">{f.label}</p>
            </div>
            <div className="w-32 shrink-0">
              <MarketplaceDetailModal
                card={cardFor(f.detail, f.kindSlug)}
                cta={CTA}
                installAction={noopAction}
                updateAction={noopAction}
                restoreAction={noopAction}
                loadDetail={async (): Promise<MarketplaceDetailLoadResult> => ({
                  ok: true,
                  detail: f.detail,
                })}
              />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
