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
import type { ReactNode } from "react";
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
    manifestLogoUrl: null,
    iconSlug: null,
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
      accentColor="rust"
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
    // The neutral CompatMeta label names its subject ("Compatibility unknown"),
    // so the row is self-describing without the neighbouring icon/column
    // (cinatra#1540) — and the bare, ambiguous "Unknown" is gone.
    expect(html).toContain(">Compatibility unknown<");
    expect(html).not.toContain(">Unknown<");
    expect(html).toContain("text-badge-xs");
    expect(html).not.toContain('data-slot="badge"');
  });
});

describe("MarketplaceListingCard — 0.5.0 §I byline in the banner (cinatra#1246)", () => {
  // The banner (coloured ground) is everything up to the body block; the body
  // starts at the `flex flex-1 flex-col px-[14px]` column. Split there so we can
  // assert WHICH region the publisher byline lands in.
  function splitBanner(html: string): { banner: string; body: string } {
    const bodyAt = html.indexOf("flex flex-1 flex-col px-[14px]");
    return { banner: html.slice(0, bodyAt), body: html.slice(bodyAt) };
  }

  it("renders the {Kind} by {Vendor} byline INSIDE the banner, not in the body block", () => {
    const html = renderCard({
      vendor: { name: "Foundry", storeUrl: "https://marketplace.cinatra.ai/store/foundry" },
    });
    const { banner, body } = splitBanner(html);
    // The publisher slot is a banner descendant now (0.5.0), never in the body.
    expect(banner).toContain('data-slot="extension-card-publisher"');
    expect(body).not.toContain('data-slot="extension-card-publisher"');
    // …and it reads white via text-current (inherits the banner ground), so it
    // recolours to match the name rather than pinning the ink/primary token.
    const byline = banner.match(/<div data-slot="extension-card-publisher"[^>]*>/)?.[0];
    expect(byline).toContain("text-current");
    expect(byline).not.toContain("text-muted-foreground");
    expect(byline).not.toContain("text-foreground");
  });

  it("clamps the banner name at 2 lines (0.5.0 §I) and reserves a 62px body block", () => {
    const html = renderCard();
    const { banner, body } = splitBanner(html);
    const nameDiv = banner.match(/<div data-slot="extension-card-name"[^>]*>/)?.[0];
    expect(nameDiv).toContain("line-clamp-2");
    expect(nameDiv).not.toContain("line-clamp-3");
    // Body reserves 62px (was 86); the description stays 3-line-clamped.
    expect(body).toContain("min-h-[62px]");
    expect(body).not.toContain("min-h-[86px]");
    expect(body).toContain("line-clamp-3");
  });

  it("shows the VERIFIED check only for a catalog-carried vendor, and the vendor links out", () => {
    const withVendor = renderCard({
      vendor: { name: "Foundry", storeUrl: "https://marketplace.cinatra.ai/store/foundry" },
    });
    expect(withVendor).toContain('data-slot="extension-card-verified"');
    expect(withVendor).toContain('href="https://marketplace.cinatra.ai/store/foundry"');
    // A derived package-scope namespace (no vendor block) is NOT verified.
    const noVendor = renderCard({ vendor: null });
    expect(noVendor).not.toContain('data-slot="extension-card-verified"');
  });
});

describe("MarketplaceListingCard — the cost text renders in EVERY install-state variant (cinatra#1273)", () => {
  // Owner CHANGES_REQUESTED on #1273 (2026-07-10): the "Update now" and
  // "Installing…" card variants dropped the cost text. The design spec 0.5.0
  // §I draws the price row on ALL six state cards — "Update · newer in catalog"
  // reads "$9/mo" (app-extensions.html L373) and "Installing · submit pending"
  // reads "$12" (L437) — never blank. The price row is a function of the
  // card's commerce badge ONLY; it must not be coupled to, or suppressed by,
  // the six-state CTA slot the caller passes. These guards render the card in
  // the exact update + installing (pending) shapes and lock that the priced
  // cost row is still present, so a future refactor can never silently drop it
  // for those two states again.
  function renderWithCta(
    badge: MarketplaceCardData["badge"],
    ctaControl: ReactNode,
    ctaState: string,
  ): string {
    return renderToStaticMarkup(
      <MarketplaceListingCard
        card={cardData({ badge })}
        accentColor="olive"
        ctaControl={ctaControl}
        ctaState={ctaState}
        detailsControl={<Button variant="link">More details</Button>}
      />,
    );
  }

  it('renders the "$9/mo" cost row on the Update-now card variant (spec §I L373)', () => {
    const html = renderWithCta(
      { text: "$9/mo", variant: "price" },
      <Button size="sm">Update now</Button>,
      "update",
    );
    // The priced cost row is present…
    expect(html).toContain('data-slot="extension-card-price"');
    expect(html).toContain(">$9/mo<");
    // …alongside the Update-now CTA (proving the two coexist, not either/or).
    expect(html).toContain('data-cta-state="update"');
    expect(html).toContain(">Update now<");
  });

  it('renders the "$12" cost row on the Installing… (pending) card variant (spec §I L437)', () => {
    // The Installing… visual is the pending label of the install submit; the
    // card is otherwise the install/update card, so the priced cost row must
    // still render above the busy button.
    const installingCta = (
      <Button size="sm" disabled data-pending="">
        Installing…
      </Button>
    );
    const html = renderWithCta({ text: "$12", variant: "price" }, installingCta, "install");
    expect(html).toContain('data-slot="extension-card-price"');
    expect(html).toContain(">$12<");
    expect(html).toContain(">Installing…<");
  });

  it("renders the priced cost row for ALL SIX install-state CTAs (the price row is CTA-state-independent)", () => {
    // Literal all-six-state guard: the price row is a pure function of the
    // commerce badge, so it must survive every resolved CTA identity the live
    // screen can pass (install · installed · update · restore · installing ·
    // incompatible). Cross every state with each commerce variant so neither
    // the state NOR the badge kind can ever gate the cost row off again.
    const ctaStates = ["install", "installed", "update", "restore", "installing", "incompatible"];
    const badges: MarketplaceCardData["badge"][] = [
      { text: "Free", variant: "free" },
      { text: "Free, Open Source", variant: "oss" },
      { text: "$9/mo", variant: "price" },
    ];
    for (const ctaState of ctaStates) {
      for (const badge of badges) {
        const html = renderWithCta(badge, <Button size="sm">CTA</Button>, ctaState);
        expect(html).toContain('data-slot="extension-card-price"');
        expect(html).toContain(`>${badge!.text}<`);
        expect(html).toContain(`data-cta-state="${ctaState}"`);
      }
    }
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
