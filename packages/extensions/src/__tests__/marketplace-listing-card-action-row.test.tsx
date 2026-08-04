/**
 * MarketplaceListingCard — the §I one-line action row, the always-on byline
 * hover text, and the removal of the vendor checkmark (cinatra#2363, spec
 * design#105).
 *
 * What these lock, and why each is worth a test:
 *
 *  1. STRUCTURE. The install control and "More details" share ONE flex row,
 *     details to the RIGHT, with the price on its own line ABOVE it. The row
 *     is the only thing that can be asserted without a layout engine; the
 *     bounding-box proof that the pair actually renders side by side at real
 *     card widths lives in tests/e2e/design/extension-card-action-row.spec.ts.
 *     What is checked here is what that suite cannot see: DOM order (a
 *     flex-row with no `*-reverse` and no `order-*` renders in source order,
 *     so "details right" IS "details second"), and the absence of any wrapper
 *     between the row and its controls.
 *
 *  2. VERBATIM CONTRACTS. `data-testid="extension-card-cta"`, `data-cta-state`
 *     and `class="contents"` are pinned by the functional-acceptance
 *     conformance suite (cinatra#985) and by role-based e2e locators. Moving
 *     the slot into a flex row is exactly the kind of edit that quietly drops
 *     one of them, so all three are re-asserted per state, along with the
 *     element TYPE of each control (button for the CTA on this card family,
 *     anchor/button for details as the caller supplies).
 *
 *  3. `display: contents` SURVIVAL. The slot must keep adding zero layout
 *     impact now that it is nested in a flex container: if it ever became a
 *     real box, it — not the control — would be the flex item, and the row
 *     would centre a full-width wrapper instead of the button.
 *
 *  4. HOVER TEXT. The exact full string, on the element that can actually clip
 *     it, for short AND long values.
 *
 *  5. NO CHECKMARK. In any vendor state, by slot, by accessible name, and by
 *     the lucide class of the glyph that used to render it.
 *
 * `packages/extensions` vitest runs in the node environment, so these are
 * static-markup assertions (the sibling marketplace-listing-card.test.tsx
 * pattern).
 */
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { MarketplaceListingCard } from "../screens/marketplace-listing-card";
import type { MarketplaceCardData } from "../screens/marketplace-card-model";

/**
 * The six CTA states the slot resolves, with the label each one renders on the
 * live screen. Deliberately restated here rather than imported: the geometry
 * suite is a Playwright project with its own tsconfig and cannot share a module
 * with a vitest file, so the six labels are kept in sync by name, and each
 * suite fails loudly on its own if a state is dropped.
 */
const SIX_CTA_STATES = [
  { state: "install", label: "Install now" },
  { state: "installed", label: "Installed" },
  { state: "update", label: "Update now" },
  { state: "restore", label: "Restore" },
  { state: "installing", label: "Installing…" },
  { state: "incompatible", label: "Install now" },
] as const;

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
    vendor: { name: "Cinatra", storeUrl: null },
    ...over,
  };
}

function renderCard(
  over: Partial<MarketplaceCardData> = {},
  opts: { ctaState?: string; ctaControl?: ReactNode; detailsControl?: ReactNode } = {},
): string {
  return renderToStaticMarkup(
    <MarketplaceListingCard
      card={cardData(over)}
      accentColor="rust"
      ctaState={opts.ctaState ?? "install"}
      ctaControl={opts.ctaControl ?? <Button size="sm">Install now</Button>}
      detailsControl={
        opts.detailsControl ?? (
          <Button type="button" variant="link" size="sm">
            More details
          </Button>
        )
      }
    />,
  );
}

/** The action row's opening tag, or undefined when the row is absent. */
function actionRowTag(html: string): string | undefined {
  return html.match(/<div data-slot="extension-card-actions"[^>]*>/)?.[0];
}

/**
 * The action row's inner HTML. The row contains no nested `</div>` other than
 * the `contents` slot's, so a lazy match to the matching depth is not needed:
 * the slice runs from the row's opening tag to the start of the footer-meta
 * block, which is the row's next sibling-of-parent marker in the markup.
 */
function actionRowRegion(html: string): string {
  const start = html.indexOf('<div data-slot="extension-card-actions"');
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf('data-slot="extension-card-meta"', start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe("MarketplaceListingCard — §I one-line action row (cinatra#2363)", () => {
  it("renders CTA and More details inside ONE flex row, details second (= right)", () => {
    const html = renderCard();
    const row = actionRowTag(html);
    expect(row).toBeDefined();

    // A single flex ROW, centred, wrappable, shrinkable. `min-w-0` is what lets
    // the row shrink to the card body instead of overflowing it, so the wrap
    // happens at the card edge.
    expect(row).toContain("flex");
    expect(row).toContain("flex-row");
    expect(row).toContain("flex-wrap");
    expect(row).toContain("items-center");
    expect(row).toContain("justify-center");
    expect(row).toContain("min-w-0");
    // Direction/order must never be inverted: with a plain flex-row, DOM order
    // IS visual order, which is the whole basis for "details on the right".
    expect(row).not.toContain("flex-row-reverse");
    expect(row).not.toContain("flex-col");

    const region = actionRowRegion(html);
    const ctaAt = region.indexOf('data-testid="extension-card-cta"');
    const detailsAt = region.indexOf("More details");
    expect(ctaAt).toBeGreaterThan(-1);
    expect(detailsAt).toBeGreaterThan(-1);
    // Details AFTER the CTA in the row → rendered to its right.
    expect(detailsAt).toBeGreaterThan(ctaAt);
    // No `order-*` utility that would visually re-sequence the pair.
    expect(region).not.toMatch(/\border-\d/);
  });

  it("keeps the price on its OWN line, above the row and outside it", () => {
    const html = renderCard();
    const priceAt = html.indexOf('data-slot="extension-card-price"');
    const rowAt = html.indexOf('data-slot="extension-card-actions"');
    expect(priceAt).toBeGreaterThan(-1);
    expect(rowAt).toBeGreaterThan(-1);
    // Price precedes the row…
    expect(priceAt).toBeLessThan(rowAt);
    // …and is NOT inside it (the row region starts after the price).
    expect(actionRowRegion(html)).not.toContain('data-slot="extension-card-price"');
    // It still centres itself rather than relying on the column's align-items,
    // which the row layout removes.
    const price = html.match(/<div data-slot="extension-card-price"[^>]*>/)?.[0];
    expect(price).toContain("text-center");
  });

  it("preserves the pinned CTA-slot contract VERBATIM inside the row, for all six states", () => {
    for (const { state, label } of SIX_CTA_STATES) {
      const html = renderCard(
        {},
        { ctaState: state, ctaControl: <Button size="sm">{label}</Button> },
      );
      const region = actionRowRegion(html);

      // The exact three pinned attributes, unchanged by the move into the row.
      expect(region).toContain(
        `<div data-testid="extension-card-cta" data-cta-state="${state}" class="contents">`,
      );
      // The control is a real <button> element (role-based e2e locks) and it
      // is the slot's direct child, so the `contents` wrapper is transparent
      // and the BUTTON is the flex item.
      expect(region).toMatch(
        new RegExp(
          `<div data-testid="extension-card-cta" data-cta-state="${state}" class="contents"><button`,
        ),
      );
      expect(region).toContain(label);
      // Details still renders alongside, after the CTA.
      expect(region.indexOf("More details")).toBeGreaterThan(
        region.indexOf('data-testid="extension-card-cta"'),
      );
    }
  });

  it("keeps the CTA slot at display:contents so the control, not the wrapper, is the flex item", () => {
    const html = renderCard();
    const slot = html.match(/<div data-testid="extension-card-cta"[^>]*>/)?.[0];
    // `contents` and nothing else — a sizing/spacing utility here would make
    // the wrapper a real box and put it in the flex flow.
    expect(slot).toContain('class="contents"');
    expect(slot).not.toMatch(/class="[^"]*\b(flex|block|inline|w-|grow|shrink)/);
  });

  it("renders an ANCHOR details control unchanged when the caller supplies one", () => {
    // The installed / agents surfaces pass an anchor (`linkTrigger`), not a
    // button — an element type the e2e locks key off. The row must wrap
    // whatever the caller hands it without substituting a tag.
    const html = renderCard(
      {},
      {
        detailsControl: (
          <Button asChild variant="link" size="sm">
            <Link href="/configuration/marketplace/cinatra-ai/blog-skills">More details</Link>
          </Button>
        ),
      },
    );
    const region = actionRowRegion(html);
    expect(region).toMatch(/<a [^>]*href="\/configuration\/marketplace\/cinatra-ai\/blog-skills"/);
    expect(region).toContain("More details");
    // …and it is still the SECOND item in the row, after the CTA.
    expect(region.indexOf("<a ")).toBeGreaterThan(
      region.indexOf('data-testid="extension-card-cta"'),
    );
  });
});

describe("MarketplaceListingCard — always-on byline hover text (cinatra#2363)", () => {
  it("carries the EXACT full '{Kind} by {Vendor}' string as a title on the ellipsised span", () => {
    const html = renderCard({ kindLabel: "Skill", vendor: { name: "Cinatra", storeUrl: null } });
    expect(html).toContain('class="overflow-hidden text-ellipsis" title="Skill by Cinatra"');
  });

  it("carries the full string for a LONG vendor that the line visibly truncates", () => {
    const longVendor = "Meridian Labs Knowledge Systems International";
    const html = renderCard({
      kindLabel: "Connector",
      vendor: { name: longVendor, storeUrl: null },
    });
    expect(html).toContain(`title="Connector by ${longVendor}"`);
    // The title element IS the one carrying the ellipsis — the only node that
    // can clip the line, and therefore the only reliable hover target.
    const span = html.match(/<span class="overflow-hidden text-ellipsis"[^>]*>/)?.[0];
    expect(span).toContain("text-ellipsis");
    expect(span).toContain(`title="Connector by ${longVendor}"`);
  });

  it("titles the missing-vendor placeholder line too (never a bare kind label)", () => {
    const html = renderCard({ kindLabel: "Agent", vendor: null });
    // Whatever the placeholder resolves to, the title is the line's full text:
    // it starts with the kind + connective and is longer than the kind alone.
    const title = html.match(/text-ellipsis" title="([^"]+)"/)?.[1];
    expect(title).toBeDefined();
    expect(title!.startsWith("Agent by ")).toBe(true);
    expect(title!.length).toBeGreaterThan("Agent by ".length);
  });

  it("keeps the title on the truncating span, not on the inner vendor node", () => {
    const html = renderCard({ vendor: { name: "Cinatra", storeUrl: null } });
    const vendorNode = html.match(/<[a-z]+ data-slot="extension-card-vendor-label"[^>]*>/)?.[0];
    expect(vendorNode).toBeDefined();
    // A title here instead would be unreachable whenever the clip eats the
    // vendor name entirely.
    expect(vendorNode).not.toContain("title=");
  });
});

describe("MarketplaceListingCard — the vendor checkmark is GONE (cinatra#2363)", () => {
  const vendorStates: [string, Partial<MarketplaceCardData>][] = [
    ["known vendor", { vendor: { name: "Cinatra", storeUrl: null } }],
    [
      "known vendor with a store link",
      { vendor: { name: "Cinatra", storeUrl: "https://marketplace.example/cinatra" } },
    ],
    ["missing vendor", { vendor: null }],
    ["blank vendor name", { vendor: { name: "   ", storeUrl: null } }],
  ];

  for (const [label, over] of vendorStates) {
    it(`renders no verification mark for a ${label}`, () => {
      const html = renderCard(over);
      // By slot…
      expect(html).not.toContain('data-slot="extension-card-verified"');
      // …by the misleading accessible name/tooltip it used to carry…
      expect(html).not.toContain("Verified vendor");
      // …and by the glyph itself, so a differently-labelled circled check
      // cannot quietly take its place.
      expect(html).not.toContain("lucide-circle-check");
    });
  }

  it("still renders the vendor byline itself — only the mark was removed", () => {
    const html = renderCard({ vendor: { name: "Cinatra", storeUrl: null } });
    expect(html).toContain('data-slot="extension-card-vendor-label"');
    expect(html).toContain("Cinatra");
    expect(html).toContain('data-vendor-state="known"');
  });
});
