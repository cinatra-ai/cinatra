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
import * as cheerio from "cheerio";

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
    // The neutral CompatMeta label names its subject ("Compatibility"), so the
    // row is self-describing without the neighbouring icon/column
    // (cinatra#1540) — and the bare, ambiguous "Unknown" is gone. The word is
    // the maintainer's decided reading (cinatra#3521): "Compatibility" alone,
    // never "Compatibility unknown".
    expect(html).toContain(">Compatibility<");
    expect(html).not.toContain(">Unknown<");
    expect(html).toContain("text-badge-xs");
    expect(html).not.toContain('data-slot="badge"');
  });
});

describe("MarketplaceListingCard — the three compatibility readings (cinatra#3521)", () => {
  // The maintainer's decided readings (cinatra#3521, 2026-09-16): "the card's
  // three readings are exactly 'Compatible' with a check icon, 'Incompatible'
  // with a cross icon, and 'Compatibility' with a question-mark icon (the
  // third for a package that declares no host range)". The icons come from the
  // app's own lucide-react set, which stamps every icon with its own
  // `lucide-{name}` class — so the rendered markup names the icon per state and
  // an icon swap is provable, not just the word.
  //
  // Both readings are taken from the compat ROW alone, never from the whole
  // card: the card draws other icons (the rating star, the banner marks), so a
  // whole-markup match could be satisfied by an icon belonging to another row
  // and hide a wrong or missing compatibility icon (codex convergence).

  /** The `data-slot="extension-card-compat"` span, icon and label included. */
  function compatRow(html: string): string {
    const at = html.indexOf('data-slot="extension-card-compat"');
    expect(at).toBeGreaterThan(-1);
    const open = html.lastIndexOf("<span", at);
    const close = html.indexOf("</span>", at);
    expect(close).toBeGreaterThan(open);
    return html.slice(open, close + "</span>".length);
  }

  /**
   * The row's visible words, read out of the PARSED row — asserted EXACTLY,
   * never by substring.
   *
   * Parsed, never tag-stripped: a single left-to-right strip pass consumes
   * from each "<" to the FIRST ">", so any ">" that is not a tag's own
   * closing bracket (one standing inside a quoted attribute value, an
   * interleaved or malformed tag) makes the pass cut in the wrong place and
   * leave markup standing in what this helper hands back as "the row's
   * visible words". `cheerio` is the repository's established parse road for
   * reading text out of markup (src/lib/artifacts/url-import.ts and its two
   * siblings) and resolves here by the same upward node_modules walk this
   * file's own `react-dom/server` import already takes.
   */
  function compatLabel(html: string): string {
    return cheerio.load(compatRow(html), null, false).root().text().trim();
  }

  /**
   * The class TOKENS on the row's own icon. Whole-token equality, so
   * `lucide-x` can never be satisfied by `lucide-x-circle` or any other
   * icon whose name merely starts with the same letters.
   */
  function compatIconTokens(html: string): string[] {
    const svg = compatRow(html).match(/<svg[^>]*>/)?.[0] ?? "";
    const className = svg.match(/class="([^"]*)"/)?.[1] ?? "";
    return className.split(/\s+/).filter(Boolean);
  }

  it("draws 'Compatible' with the check icon when the declared range is satisfied", () => {
    const html = renderCard({ sdkAbiRange: "^2" });
    expect(html).toContain('data-compat-state="compatible"');
    expect(compatLabel(html)).toBe("Compatible");
    expect(compatIconTokens(html)).toContain("lucide-check");
  });

  it("draws 'Incompatible' with the cross icon when the declared range is not satisfied", () => {
    // "^1" is the established known-unsatisfied fixture range (see
    // src/lib/__tests__/extension-compat-badge.test.ts) — this host's frozen
    // SDK-extensions ABI is "^2".
    const html = renderCard({ sdkAbiRange: "^1" });
    expect(html).toContain('data-compat-state="incompatible"');
    expect(compatLabel(html)).toBe("Incompatible");
    expect(compatIconTokens(html)).toContain("lucide-x");
    // The warning triangle this line carried before the decision is gone.
    expect(compatIconTokens(html)).not.toContain("lucide-triangle-alert");
  });

  it("draws 'Compatibility' — the word alone — with the question-mark icon when no range is declared", () => {
    const html = renderCard({ sdkAbiRange: null });
    expect(html).toContain('data-compat-state="unknown"');
    // Exact equality: "Compatibility unknown" fails this, the word alone passes.
    expect(compatLabel(html)).toBe("Compatibility");
    expect(compatIconTokens(html)).toContain("lucide-circle-question-mark");
  });

  it("reads the row's visible words when an attribute value carries a '>', leaving no markup standing", () => {
    // A single left-to-right tag-stripping pass consumes from each "<" to the
    // FIRST ">", so a ">" standing INSIDE a quoted attribute value ends that
    // match early and leaves the attribute's tail standing in what the helper
    // hands back as "the row's visible words". The reading has to come from
    // the PARSED markup, where an attribute value is an attribute and can
    // never be mistaken for text. Hand-built row markup (not a card render),
    // because the reading is a property of the helper, not of today's card.
    const html =
      '<div class="meta"><span data-slot="extension-card-compat" data-compat-state="compatible"' +
      ' title="host range >=2"><svg class="lucide lucide-check size-[11px]"></svg>Compatible</span></div>';
    expect(compatLabel(html)).toBe("Compatible");
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

  it("never renders the (removed) VERIFIED checkmark, for a known OR missing vendor, and the vendor still links out (cinatra#2362/#2363)", () => {
    const withVendor = renderCard({
      vendor: { name: "Foundry", storeUrl: "https://marketplace.cinatra.ai/store/foundry" },
    });
    // The checkmark rendered on `vendor.kind === "known"` alone (never a real
    // verification field) and its "Verified vendor" title was misleading —
    // removed for every vendor state (cinatra#2363).
    expect(withVendor).not.toContain('data-slot="extension-card-verified"');
    expect(withVendor).toContain('href="https://marketplace.cinatra.ai/store/foundry"');
    expect(withVendor).toContain('data-vendor-state="known"');
    // A missing vendor (no block) renders the placeholder, still no mark.
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

  it("renders the display name as the label (slug ignored) when a real name is present, with no VERIFIED checkmark (cinatra#2362/#2363)", () => {
    const html = renderFromCatalog({
      vendor: { name: "Distinct Vendor Name", slug: "machine-slug-sentinel", store_url: "https://marketplace.cinatra.ai/store/distinct" },
    });
    expect(vendorLabel(html)).toBe("Distinct Vendor Name");
    expect(vendorLabel(html)).not.toContain("machine-slug-sentinel");
    expect(html).toContain('data-vendor-state="known"');
    // The checkmark is removed for every vendor state, including "known".
    expect(html).not.toContain('data-slot="extension-card-verified"');
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

  it("carries a native always-on title= on the vendor label with the FULL text, on a short name AND a long/truncated one (cinatra#2363)", () => {
    // Short, non-linked vendor name (the plain <span> variant of the slot).
    const shortHtml = renderFromCatalog({
      vendor: { name: "Foundry", slug: "machine-slug-sentinel", store_url: null },
    });
    const shortLabelTag = shortHtml.match(/<span[^>]*data-slot="extension-card-vendor-label"[^>]*>/)?.[0];
    expect(shortLabelTag).toContain('title="Foundry"');

    // Long name, linked (the <Link> variant of the same slot).
    const longName = "A Very Long Vendor Display Name That Overflows The Ellipsised Byline Row";
    const longHtml = renderFromCatalog({
      vendor: { name: longName, slug: "machine-slug-sentinel", store_url: "https://marketplace.cinatra.ai/store/long" },
    });
    const longLabelTag = longHtml.match(/<a[^>]*data-slot="extension-card-vendor-label"[^>]*>/)?.[0];
    expect(longLabelTag).toContain(`title="${longName}"`);
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

describe("MarketplaceListingCard — footer meta cannot be clipped by the card (cinatra#2409)", () => {
  // The card root is `overflow-hidden` and EVERY child of the meta row is
  // `whitespace-nowrap`: the left column is a grid (min-width:auto — it
  // cannot shrink) and the right column is `shrink-0` on purpose (squeezing a
  // nowrap verdict clips it just as badly). With no fit strategy the row's
  // intrinsic width overflowed the card body at the widths this card actually
  // renders at, and the overflow was SILENTLY sliced — "Compatibility
  // unknown" rendered as "Compatibilit", "Updated about 1 month ago" lost its
  // tail. The geometric proof lives in
  // tests/e2e/design/marketplace-listing-card-geometry.spec.ts §4; this pins
  // the three class-level decisions that proof depends on.
  function metaRow(html: string): string {
    const at = html.indexOf('data-slot="extension-card-meta"');
    expect(at).toBeGreaterThan(-1);
    return html.slice(at, html.indexOf(">", at) + 1);
  }

  it("gives the meta row a wrap allowance so a non-fitting column drops instead of overflowing", () => {
    const row = metaRow(renderCard());
    expect(row).toContain("flex-wrap");
    // Axis-split gaps: the wrapped arrangement needs its own (tighter) row
    // gap, so the single-line column gap is not reused vertically.
    expect(row).toContain("gap-x-3.5");
    expect(row).toContain("gap-y-2");
  });

  it("keeps the compat/freshness column right-aligned in BOTH arrangements", () => {
    // `ml-auto` right-aligns the column when it wraps onto its own line (where
    // `justify-between` would leave it at the start) and does the
    // justify-between job on the one-line path — one rule, both arrangements.
    const html = renderCard();
    const at = html.indexOf('data-slot="extension-card-compat"');
    const column = html.lastIndexOf("<div", at);
    expect(html.slice(column, at)).toContain("ml-auto");
  });

  it("keeps the nowrap verdict unshrinkable — the row wraps, the label is never squeezed", () => {
    const html = renderCard({ sdkAbiRange: null });
    const at = html.indexOf('data-slot="extension-card-compat"');
    const column = html.lastIndexOf("<div", at);
    expect(html.slice(column, at)).toContain("shrink-0");
    // The full label survives: a fit strategy that truncated it would satisfy
    // "does not overflow" while still failing the actual requirement.
    expect(html).toContain(">Compatibility<");
  });
});
