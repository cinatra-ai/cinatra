/**
 * MarketplaceListingCard — §IV ListingCard footer-meta regressions (cinatra#1003,
 * owner CHANGES_REQUESTED on #1003 2026-07-05):
 *
 *  1. The compat verdict ("Compatible"/"Incompatible"/"Unknown") is a PLAIN
 *     meta row, never a Badge/pill — the pinned drawing (§IV L481/L631) shows
 *     an icon + text identical in anatomy to "Updated N ago", no chrome.
 *  2. The rating stars use the dedicated `text-rating-star` /
 *     `text-rating-star-muted` tokens (`#f5a623` / `#d0cbbd`, spec §IV L477),
 *     not the semantic ink/muted tokens (which read as plain grey).
 *
 * `packages/extensions` vitest runs with `environment: "node"` (see
 * vitest.config.ts) — `renderToStaticMarkup` (react-dom/server) needs no DOM,
 * so static-markup assertions are used throughout, matching the sibling
 * `src/components/__tests__/extension-card.test.tsx` pattern.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { Button } from "@/components/ui/button";
import { MarketplaceListingCard } from "../screens/marketplace-listing-card";
import type { MarketplaceCardData } from "../screens/marketplace-card-model";

function cardData(over: Partial<MarketplaceCardData> = {}): MarketplaceCardData {
  return {
    packageName: "@cinatra-ai/blog-skills",
    packageVersion: "0.1.0",
    displayName: "Blog Skills",
    description: "Blog authoring skills.",
    kindSlug: "skill",
    kindLabel: "Skill",
    badge: { text: "Free", variant: "free" },
    freshnessAt: "2026-06-01T00:00:00Z",
    rating: { average: 4.6, count: 124 },
    detailHref: "/configuration/marketplace/cinatra-ai/blog-skills",
    installCount: 880,
    iconUrl: null,
    vendorLogoUrl: null,
    sdkAbiRange: null,
    vendor: null,
    ...over,
  };
}

function renderCard(over: Partial<MarketplaceCardData> = {}): string {
  return renderToStaticMarkup(
    <MarketplaceListingCard
      card={cardData(over)}
      accentColor="indigo"
      ctaControl={<Button size="sm">Install now</Button>}
      detailsControl={<Button variant="link">More details</Button>}
    />,
  );
}

describe("MarketplaceListingCard — footer-meta compat verdict is plain text, not a badge", () => {
  // Regression guard (codex-caught, cinatra#1003): the app's plain `cn`
  // (@/lib/utils, NOT the sdk-ui EXTENDED tailwind-merge) silently drops the
  // `text-badge-xs` SIZE token whenever it is merged via cn() alongside a
  // text-COLOR class in the same call — `twMerge("font-mono text-badge-xs",
  // "text-foreground")` → `"font-mono text-foreground"`, no size class left.
  // CompatMeta must build its className via plain string concatenation (not
  // cn()) to keep text-badge-xs; assert its literal presence on every state
  // so a future refactor back to cn() fails loudly instead of silently
  // rendering the compat row at the wrong (default) font size.
  it("renders the Compatible state as a plain icon+label row, not a Badge component", () => {
    const html = renderCard({ sdkAbiRange: "^2" });
    expect(html).toContain('data-slot="extension-card-compat"');
    expect(html).toContain('data-compat-state="compatible"');
    expect(html).toContain(">Compatible<");
    expect(html).toContain("text-badge-xs");
    // The shadcn Badge primitive always carries data-slot="badge"; the plain
    // meta row must not.
    expect(html).not.toContain('data-slot="badge"');
  });

  it("renders the Incompatible state as a plain destructive-red icon+label row, not a Badge", () => {
    // "^1" is the established known-unsatisfied fixture range (see
    // src/lib/__tests__/extension-compat-badge.test.ts) — this host's frozen
    // SDK-extensions ABI is "^2".
    const html = renderCard({ sdkAbiRange: "^1" });
    expect(html).toContain('data-compat-state="incompatible"');
    expect(html).toContain(">Incompatible<");
    expect(html).toContain("text-destructive");
    expect(html).toContain("text-badge-xs");
    expect(html).not.toContain('data-slot="badge"');
  });

  it("renders the Unknown state (no declared ABI range) as the same plain anatomy, never green", () => {
    const html = renderCard({ sdkAbiRange: null });
    expect(html).toContain('data-compat-state="unknown"');
    expect(html).toContain(">Unknown<");
    expect(html).toContain("text-badge-xs");
    expect(html).not.toContain('data-slot="badge"');
  });
});

describe("MarketplaceListingCard — rating stars use the dedicated rating-star colour tokens", () => {
  it("uses text-rating-star / text-rating-star-muted, not the semantic ink/muted tokens", () => {
    const html = renderCard({ rating: { average: 4, count: 12 } });
    expect(html).toContain("text-rating-star");
    expect(html).toContain("text-rating-star-muted");
    // The prior (wrong) treatment inked every star with text-foreground and
    // dimmed the empty ones via opacity — neither should remain.
    expect(html).not.toContain("opacity-40");
  });

  it("renders no rating row at all when the card carries no rating", () => {
    const html = renderCard({ rating: null });
    expect(html).not.toContain("text-rating-star");
  });
});
