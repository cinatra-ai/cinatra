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
import { catalogEntryToCardData, type MarketplaceCardData } from "../screens/marketplace-card-model";

// The card mapper's raw-entry type, DERIVED from its own signature rather than
// imported directly from the vendored marketplace MCP client package: that
// vendored specifier is banned for NEW imports (the vendored-import regression
// guard), and the published `@cinatra-ai/marketplace-mcp-contract` does not
// export this type yet. Deriving it keeps this test off the vendored specifier.
type MarketplaceCatalogEntry = Parameters<typeof catalogEntryToCardData>[0];

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

  it("shows the VERIFIED check only for a known vendor, and the vendor links out", () => {
    const withVendor = renderCard({
      vendor: { name: "Foundry", storeUrl: "https://marketplace.cinatra.ai/store/foundry" },
    });
    expect(withVendor).toContain('data-slot="extension-card-verified"');
    expect(withVendor).toContain('href="https://marketplace.cinatra.ai/store/foundry"');
    expect(withVendor).toContain('data-vendor-state="known"');
    // A missing vendor (no block) renders the placeholder, NO verified mark.
    const noVendor = renderCard({ vendor: null });
    expect(noVendor).not.toContain('data-slot="extension-card-verified"');
    expect(noVendor).toContain('data-vendor-state="missing"');
  });
});

describe("MarketplaceListingCard — §I vendor byline never substitutes a machine identifier (cinatra#1528)", () => {
  // Feed RAW catalog input with distinct sentinels through catalogEntryToCardData
  // (exercising normalization) and render the REAL card, then assert the EXACT
  // visible vendor-label node — the package scope and vendor slug legitimately
  // appear elsewhere (detail href, package text), so the whole-DOM must not be
  // asserted.
  function renderFromCatalog(over: Partial<MarketplaceCatalogEntry>): string {
    const card = catalogEntryToCardData({
      package_name: "@scope-sentinel/pkg",
      scope: "scope-sentinel",
      extension_name: "pkg",
      version: "0.1.0",
      kind_slug: "skill",
      kind_label: "Skill",
      display_name: "Sentinel Skill",
      description: "Sentinel description",
      badge: { text: "Open source", variant: "oss", license: "Apache-2.0" },
      freshness_at: "2026-06-01T00:00:00Z",
      rating: { average: 4, count: 12 },
      vendor_logo_key: null,
      permalink: "https://marketplace.cinatra.ai/product/pkg",
      ...over,
    });
    return renderToStaticMarkup(
      <MarketplaceListingCard
        card={card!}
        accentColor="rust"
        ctaControl={<Button size="sm">Install now</Button>}
        detailsControl={<Button variant="link">More details</Button>}
      />,
    );
  }

  /** The EXACT visible text inside the vendor-label node (a link or a span). */
  function vendorLabel(html: string): string | undefined {
    return html.match(/data-slot="extension-card-vendor-label"[^>]*>([^<]*)</)?.[1];
  }

  it("renders the display name as the label (slug ignored) when a real name is present", () => {
    const html = renderFromCatalog({
      vendor: { name: "Distinct Vendor Name", slug: "machine-slug-sentinel", store_url: "https://marketplace.cinatra.ai/store/distinct" },
    });
    expect(vendorLabel(html)).toBe("Distinct Vendor Name");
    expect(vendorLabel(html)).not.toContain("machine-slug-sentinel");
    expect(html).toContain('data-vendor-state="known"');
    expect(html).toContain('data-slot="extension-card-verified"');
  });

  it("renders the missing-vendor placeholder — never the slug, never the package scope — when the name is blank", () => {
    const html = renderFromCatalog({
      vendor: { name: "  ", slug: "machine-slug-sentinel", store_url: "https://marketplace.cinatra.ai/store/x" },
    });
    expect(vendorLabel(html)).toBe("Unknown vendor");
    expect(vendorLabel(html)).not.toContain("machine-slug-sentinel");
    expect(vendorLabel(html)).not.toContain("scope-sentinel");
    // Missing → plain text, no verified mark, and never linked (not even via a
    // surviving store URL).
    expect(html).toContain('data-vendor-state="missing"');
    expect(html).not.toContain('data-slot="extension-card-verified"');
    expect(html).not.toContain('href="https://marketplace.cinatra.ai/store/x"');
  });

  it("renders the placeholder when the catalog carries no vendor block (no package-scope fallback)", () => {
    const html = renderFromCatalog({});
    expect(vendorLabel(html)).toBe("Unknown vendor");
    expect(vendorLabel(html)).not.toContain("scope-sentinel");
    expect(html).toContain('data-vendor-state="missing"');
  });

  it("keeps a long / Unicode display name as the full accessible label (never slug-ified)", () => {
    // No HTML-special chars (renderToStaticMarkup would entity-escape them),
    // so the exact-text match reads the rendered label verbatim.
    const name = "Ştefan Associés — Ελληνικά Εργαλεία 日本語ツール Studio";
    const html = renderFromCatalog({
      vendor: { name, slug: "machine-slug-sentinel", store_url: null },
    });
    expect(vendorLabel(html)).toBe(name);
    expect(html).toContain('data-vendor-state="known"');
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
