"use client";

// ---------------------------------------------------------------------------
// Seeded fixtures for the §V extension-detail modal (cinatra#989).
//
// Renders the REAL MarketplaceDetailModal with an injected loader that
// resolves a deterministic MarketplaceDetailView — no storefront round-trip,
// no registry, no DB. Two instances cover the §V evidence matrix:
//
//   1. populated — README + full specs column (incl. the plain "Compatible
//      up to" row), a multi-version changelog with the "Latest" badge,
//      declared `cinatra.dependencies`, two reviews.
//   2. empty     — the graceful states: description fallback, "—" spec
//      values, "No changelog available", none-declared dependencies
//      (section omitted), zero reviews.
//
// Per the §V drawing the modal hero is the plain light panel on the dialog
// paper — NO banner, scrim, or coloured ground renders anywhere in the modal
// (the client-safe MarketplaceDetailView carries no banner field at all).
// The footer CTA renders the ENABLED primary "Install now" — the §V default
// state drawing.
// ---------------------------------------------------------------------------

// Deep module import ON PURPOSE: the screens barrel re-exports the
// registry-catalog SERVER screen (pacote/child_process reach), which a client
// component page must never pull into the browser graph. The modal module
// itself is "use client" and client-safe. Type-only imports from the barrel
// are erased at compile time and are safe.
import { MarketplaceDetailModal } from "@cinatra-ai/extensions/screens/marketplace-detail-modal";
import type { ModalInstallScopeContext } from "@cinatra-ai/extensions/screens/marketplace-detail-modal";
import type { MarketplaceCardData, MarketplaceCardCta } from "@cinatra-ai/extensions/screens";
import {
  buildMarketplaceFailureCopy,
  marketplaceFailureCopy,
} from "@cinatra-ai/extensions/screens/marketplace-failure-copy";
import type { InstallTarget } from "@cinatra-ai/agents/install-targets";
import type {
  MarketplaceDetailLoadResult,
  MarketplaceDetailView,
} from "@/lib/marketplace-detail-view";
import { emptyRatingSummary } from "@/lib/marketplace-detail-view";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
  "",
  "```",
  'cinatra run research-assistant --query "Q3 churn drivers"',
  "```",
].join("\n");

// The §V drawing's specs-column value ("Compatible up to · Cinatra v{version}"),
// stored bare — the "Cinatra v" prefix is presentation, applied at render.
const COMPATIBLE_UP_TO_FIXTURE = "0.2.0";

// NB: every fixture packageName is FICTIONAL — naming a real extension here
// would hardcode an extension-instance reference into core (the
// core-extension-instance-coupling-ban gate rejects it).

/** Fixture 1 — fully populated: specs, changelog, dependencies, reviews. */
const POPULATED_DETAIL: MarketplaceDetailView = {
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
  compatibleUpTo: COMPATIBLE_UP_TO_FIXTURE,
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

/** Fixture 2 — the graceful empty states throughout. */
const EMPTY_DETAIL: MarketplaceDetailView = {
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
  compatibleUpTo: null,
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

/**
 * Fixture 3 — an access-target kind (connector). Its footer "Install now" must
 * open the pre-install access-scope dialog LAYERED above the modal (cinatra#1541,
 * reusing cinatra#805), NOT submit directly — the regression this fixture and
 * the paired e2e guard against. Minimal detail body; the point is the footer.
 */
const CONNECTOR_DETAIL: MarketplaceDetailView = {
  packageName: "@cinatra-ai/example-connector",
  displayName: "Example Connector",
  kindLabel: "Connector",
  cost: "Free",
  license: null,
  latestVersion: "1.0.0",
  freshnessAt: "2026-06-10T12:00:00.000Z",
  installCount: 120,
  permalink: "https://marketplace.cinatra.ai/product/example-connector",
  sdkAbiRange: null,
  readmeMarkdown: null,
  longDescription: null,
  description: "A sample connector whose install offers the pre-install access-scope selector.",
  iconUrl: null,
  compatibleUpTo: null,
  changelog: [],
  dependencies: [],
  ratingSummary: emptyRatingSummary(),
  reviews: [],
  vendor: {
    name: "Cinatra",
    slug: "cinatra",
    storeUrl: "https://marketplace.cinatra.ai/store/cinatra",
  },
};

// Seeded already-authorized picker rows — one org + one team scope, the same
// shape buildInstallTargetPickerContext computes server-side (id-carrying
// "org:<id>" token, #1562). No DB: the fixture stands in for the server context
// so the layered dialog renders on the production-equivalent /design-fixtures
// route. The action is a side-effect-free stand-in (no persistence here — the
// completed-install proof is a separate operator-gated run).
const CONNECTOR_INSTALL_TARGETS: InstallTarget[] = [
  { value: "org:acme", label: "Anyone in Acme Corp", level: "organization", id: "acme", disabled: false },
  { value: "team:eng", label: "Engineering", level: "team", id: "eng", disabled: false },
];
const CONNECTOR_INSTALL_SCOPE: ModalInstallScopeContext = {
  installTargets: CONNECTOR_INSTALL_TARGETS,
  ownerEntityNames: { "org:acme": "Acme Corp", "team:eng": "Engineering" },
  activeOrgId: "acme",
  defaultValue: "org:acme",
  failureCopyByCategory: buildMarketplaceFailureCopy("install", CONNECTOR_DETAIL.displayName),
  defaultFailureMessage: marketplaceFailureCopy("unrecoverable", "install", CONNECTOR_DETAIL.displayName),
  installAction: async () => {},
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
    manifestLogoUrl: null,
    iconSlug: null,
    iconUrl: null,
    vendorLogoUrl: null,
    vendor: detail.vendor ? { name: detail.vendor.name, storeUrl: detail.vendor.storeUrl } : null,
    sdkAbiRange: detail.sdkAbiRange,
  };
}

// Deterministic, side-effect-free stand-ins for the bound server actions.
// The CTA is the ENABLED install state so the footer renders the §V drawing's
// default: the primary (indigo) "Install now", right-aligned at natural width.
const CTA: MarketplaceCardCta = { state: "install", disabled: false };
const noopAction = async () => {};

const FIXTURES: Array<{
  testId: string;
  label: string;
  detail: MarketplaceDetailView;
  kindSlug: MarketplaceCardData["kindSlug"];
  installScope?: ModalInstallScopeContext;
}> = [
  {
    testId: "modal-fixture-populated",
    label: "Populated — specs, changelog, dependencies, reviews",
    detail: POPULATED_DETAIL,
    kindSlug: "agent",
  },
  {
    testId: "modal-fixture-empty",
    label: "Empty states — no changelog, none-declared dependencies, no reviews",
    detail: EMPTY_DETAIL,
    kindSlug: "skill",
  },
  {
    testId: "modal-fixture-connector",
    label: "Access-target kind — Install now opens the access-scope dialog layered above the modal",
    detail: CONNECTOR_DETAIL,
    kindSlug: "connector",
    installScope: CONNECTOR_INSTALL_SCOPE,
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
                installScope={f.installScope}
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
