"use client";

/**
 * The extensions drawing's coloured-panel hover of an agent card (surface:
 * agent-card-accent-hover) on the conformance harness. ONE shipped AgentAllCard
 * with a SCOPED listing row: its coloured panel is the interactive Link that
 * opens the detail modal in place through the fixture-only `loadDetail`, which
 * resolves one deterministic detail at once — no session, store, network or
 * timer. Nothing of the card is restyled here; the hover wash is the product's.
 */
import { AgentAllCard } from "@/components/extensions/agent-all-card";
import {
  emptyRatingSummary,
  type MarketplaceDetailLoadResult,
  type MarketplaceDetailView,
} from "@/lib/marketplace-detail-view";

// Anti-lookalike (the rule of agents-card-fixtures.tsx): the display name shares
// no token with the package slug, so a title bound to the slug rather than the
// loaded detail would read differently.
const ACCENT_DETAIL: MarketplaceDetailView = {
  packageName: "@cinatra-fixtures/lumen-ledger",
  displayName: "Harbor Briefing Agent",
  kindLabel: "Agent",
  cost: "Free",
  license: "Apache-2.0",
  latestVersion: "1.0.0",
  freshnessAt: "2026-06-30T12:00:00.000Z",
  installCount: 12,
  permalink: null,
  sdkAbiRange: null,
  readmeMarkdown: null,
  longDescription: null,
  description: "Deterministic seed agent for the coloured-panel hover surface.",
  iconUrl: null,
  compatibleUpTo: null,
  changelog: [],
  dependencies: [],
  ratingSummary: emptyRatingSummary(),
  reviews: [],
  vendor: { name: "Cinatra Fixtures", slug: "cinatra-fixtures", storeUrl: null },
};

const loadAccentDetail = async (): Promise<MarketplaceDetailLoadResult> => ({
  ok: true,
  detail: ACCENT_DETAIL,
});

export function AgentCardAccentHoverFixture() {
  return (
    <section data-surface-id="agent-card-accent-hover" data-state="kind:agent">
      <AgentAllCard
        row={{
          key: "harbor-briefing",
          name: "Harbor Briefing Agent",
          description: "Deterministic seed agent for the coloured-panel hover surface.",
          host: "local",
          runHref: "#run-harbor-briefing",
          packageName: ACCENT_DETAIL.packageName,
          detailHref: "#detail-harbor-briefing",
        }}
        loadDetail={loadAccentDetail}
      />
    </section>
  );
}
