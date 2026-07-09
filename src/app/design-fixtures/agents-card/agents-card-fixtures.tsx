"use client";

// ---------------------------------------------------------------------------
// /agents "All Agents" card — accent-panel-as-detail-hotspot conformance
// fixture (cinatra#1121). Mounts the REAL AgentAllCard (the same component the
// /agents picker renders) with an injected deterministic detail loader, so the
// coloured accent panel → detail-modal interaction is verifiable on a
// production-equivalent build without a session or storefront round-trip
// (mirrors the marketplace-detail-modal fixture convention).
//
// Two rows:
//   • agents-card-interactive — a scoped listing: the coloured accent panel AND
//     the "More details" link both open the §V detail modal in place.
//   • agents-card-inert — an external A2A / unscoped agent (no listing): the
//     accent panel stays inert (default cursor, no modal), Run only.
// ---------------------------------------------------------------------------

import { AgentAllCard } from "@/components/extensions/agent-all-card";
import {
  emptyRatingSummary,
  type MarketplaceDetailLoadResult,
  type MarketplaceDetailView,
} from "@/lib/marketplace-detail-view";

// Anti-lookalike: the displayName shares no token with the package slug, so a
// title bound to the slug (rather than the loaded detail) would be a red.
const DETAIL: MarketplaceDetailView = {
  packageName: "@cinatra-fixtures/orbit-scheduler-agent",
  displayName: "Research Assistant Agent",
  kindLabel: "Agent",
  cost: "Free",
  license: "Apache-2.0",
  latestVersion: "1.2.0",
  freshnessAt: "2026-06-30T12:00:00.000Z",
  installCount: 42,
  permalink: null,
  sdkAbiRange: null,
  readmeMarkdown: null,
  longDescription: null,
  description:
    "Deterministic seed agent for the accent-panel detail-modal fixture.",
  iconUrl: null,
  compatibleUpTo: null,
  changelog: [],
  dependencies: [],
  ratingSummary: emptyRatingSummary(),
  reviews: [],
  vendor: { name: "Cinatra Fixtures", slug: "cinatra-fixtures", storeUrl: null },
};

const seededLoadDetail = async (): Promise<MarketplaceDetailLoadResult> => ({
  ok: true,
  detail: DETAIL,
});

export function AgentsCardAccentFixtures() {
  return (
    <div className="flex flex-col gap-4">
      <div data-surface-id="agents-card-interactive">
        <AgentAllCard
          row={{
            key: "research-assistant",
            name: "Research Assistant Agent",
            description:
              "Deterministic seed agent for the accent-panel detail-modal fixture.",
            host: "local",
            runHref: "#run-research-assistant",
            packageName: DETAIL.packageName,
            detailHref: "#detail-research-assistant",
          }}
          loadDetail={seededLoadDetail}
        />
      </div>

      <div data-surface-id="agents-card-inert">
        <AgentAllCard
          row={{
            key: "external-a2a",
            name: "External A2A Agent",
            description: "An external agent with no marketplace listing.",
            host: "some-connector",
            runHref: "#run-external",
            packageName: null,
            detailHref: null,
          }}
        />
      </div>
    </div>
  );
}
