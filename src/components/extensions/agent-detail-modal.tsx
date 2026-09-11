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
import type { MarketplaceDetailLoadResult } from "@/lib/marketplace-detail-view";

export type AgentDetailModalProps = {
  /** Human-readable agent name — the modal title (never the package slug). */
  name: string;
  description?: string | null;
  /** Scoped npm package name — the loader key + modal card identity. */
  packageName: string;
  /**
   * /configuration/marketplace/<scope>/<name> — the linkTrigger's no-JS
   * fallback href (JS opens the modal in place instead of navigating).
   *
   * NULL on a per-scope tab card (cinatra#2808): that surface is member-facing,
   * and "no member-facing surface renders a link into `/configuration` for a
   * non-admin" (epic #2699). There is nothing to fall back TO either — the
   * in-app full-page detail route is retired (cinatra#2736: this modal "is the
   * app's ONLY extension-detail surface") — so the opener is the modal's own
   * default "More details" BUTTON rather than an anchor. The modal itself is
   * unchanged and identical in both cases.
   */
  detailHref?: string | null;
  /**
   * Controlled open state (cinatra#1121). The /agents All-Agents card lifts the
   * modal's open state so the SAME modal is opened by both the "More details"
   * link AND the card's coloured accent panel (a separate sibling hit-area).
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Detail loader override — defaults to the MEMBER-gated
   * getAgentMarketplaceDetailAction (the production loader). Injectable so the
   * /design-fixtures harness can seed a deterministic detail without a session;
   * production callers never pass it.
   */
  loadDetail?: (packageName: string) => Promise<MarketplaceDetailLoadResult>;
};

export function AgentDetailModal({
  name,
  description,
  packageName,
  detailHref,
  open,
  onOpenChange,
  loadDetail = getAgentMarketplaceDetailAction,
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
    // Unread by the modal (it renders no link to a detail page); carried only
    // to satisfy the card wire shape.
    detailHref: detailHref ?? "",
    installCount: null,
    manifestLogoUrl: null,
    iconSlug: null,
    iconUrl: null,
    vendorLogoUrl: null,
    vendor: null,
    sdkAbiRange: null,
  };
  return (
    <MarketplaceDetailModal
      card={card}
      loadDetail={loadDetail}
      {...(detailHref ? { linkTrigger: { variant: "link" as const, href: detailHref } } : {})}
      open={open}
      onOpenChange={onOpenChange}
    />
  );
}
