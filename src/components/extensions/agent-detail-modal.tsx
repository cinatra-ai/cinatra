"use client";

// ---------------------------------------------------------------------------
// AgentDetailModal — the §V marketplace-detail modal wired for an /agents
// "All Agents" agent card (cinatra#1016 / design#25 §VIII; owner ruling
// 2026-07-06: "More details" opens the §V detail modal, gated by the SAME
// access as the agent card).
//
// Lives in app-src (NOT @cinatra-ai/agents) on purpose: it bridges
// @cinatra-ai/extensions' <MarketplaceDetailModal> and the app-src
// member-gated loader. @cinatra-ai/extensions already imports
// @cinatra-ai/agents, so importing the modal directly into packages/agents
// would form a build cycle (agents ↔ extensions). agent-run-client consumes
// this component via the app-src `@/` alias — exactly as it already consumes
// InstalledExtensionCard — keeping packages/agents' dependency surface
// unchanged.
//
// DETAILS-ONLY: no footer props are passed → the modal renders no footer bar
// (an agent picker never installs/uninstalls from this surface). The loader is
// the MEMBER-gated getAgentMarketplaceDetailAction (requireAuthSession — the
// same floor as /agents), NOT the admin-gated browse action, so a member who
// can already see the agent card can open its modal (no /not-authorized
// bounce). `linkTrigger` renders the §VI link-styled "More details" anchor
// whose `href` is the full-page detail (a no-JS progressive-enhancement
// fallback); JS intercepts the click to open the modal in place. The modal
// title renders the human-readable `displayName`, never the package slug.
// ---------------------------------------------------------------------------

import { MarketplaceDetailModal } from "@cinatra-ai/extensions/screens/marketplace-detail-modal";
import type { MarketplaceCardData } from "@cinatra-ai/extensions/screens";
import { getAgentMarketplaceDetailAction } from "@/lib/marketplace-detail-actions";

export type AgentDetailModalProps = {
  /** Human-readable agent name — the modal title (never the package slug). */
  name: string;
  description?: string | null;
  /** Scoped npm package name — the loader key + modal card identity. */
  packageName: string;
  /**
   * /configuration/marketplace/<scope>/<name> — the linkTrigger's no-JS
   * fallback href (JS opens the modal in place instead of navigating).
   */
  detailHref: string;
};

export function AgentDetailModal({
  name,
  description,
  packageName,
  detailHref,
}: AgentDetailModalProps) {
  // Reuses the browse-card wire shape; storefront-owned fields (rating, badge,
  // freshness, assets, vendor, ABI) stay null — the modal hydrates them from
  // the fetched public detail on open, so the card shell only carries install
  // identity + the human-readable displayName the modal title renders. In
  // details-only mode (no footer CTA) the modal shows the version from the
  // fetched detail's specs, so packageVersion is unused here → "".
  const card: MarketplaceCardData = {
    packageName,
    packageVersion: "",
    displayName: name,
    description: description || null,
    kindSlug: "agent",
    kindLabel: "Agent",
    badge: null,
    freshnessAt: null,
    rating: null,
    detailHref,
    installCount: null,
    iconUrl: null,
    vendorLogoUrl: null,
    vendor: null,
    sdkAbiRange: null,
  };
  return (
    <MarketplaceDetailModal
      card={card}
      loadDetail={getAgentMarketplaceDetailAction}
      linkTrigger={{ variant: "link", href: detailHref }}
    />
  );
}
