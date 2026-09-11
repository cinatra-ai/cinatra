// @vitest-environment jsdom
//
// The §I.1 in-card install panel's header close ✕, measured on the RENDERED
// card rather than on its source text (cinatra#2737, second proof round).
//
//   pnpm exec vitest run \
//     src/components/__tests__/extension-install-panel-close-control.test.tsx
//
// The sibling `install-panel-drawing-conformance.test.ts` pins the control's
// SHAPE from source text (24×24, the shared radius, the 0.85 opacity, the 10px
// corner offset). Two things that file cannot see were measured as defects on
// the live boot, and both are rendered facts of the composed card:
//
//   1. THE INK. The drawing paints the mark
//        `color: var(--surface-strong); opacity: 0.85`
//      on the category header band — white, the same ink the band's name and
//      byline take (`ACCENT_PALETTE[accent].fg`). The control carries
//      `text-current`, i.e. `currentColor`, and the comment beside it claims it
//      "inherit[s] the banner's fg (white)" — but the control is mounted as a
//      SIBLING of the banner in the install face's overlay, not inside it, so
//      nothing on its ancestor path declares the band's ink and `currentColor`
//      falls through to the page's own foreground. That reads near-white in the
//      dark palette by accident and dark ink in the light one, over a saturated
//      band that is the SAME colour in both palettes.
//
//   2. THE TITLE'S TRAILING SPACE. The banner's name reserves room only when a
//      `badges` slot is passed, and the install face deliberately passes none,
//      so a long title runs under the close control's own box.
//
// HOW THE INK IS MEASURED HERE. Tailwind's utilities are not compiled into the
// jsdom document and `text-current` is the identity, so every colour in this
// subtree comes from an inline declaration; `currentColor` therefore resolves
// to the nearest ancestor that declares one — the same walk the browser made
// when the proof round sampled the ✕ strokes over the band.
//
// WHAT THIS FILE IS NOT. No stylesheet is loaded and nothing is laid out, so
// these are assertions on what the composed tree DECLARES, read in the order a
// browser would resolve it — not computed style and not a bounding box. They
// assume LTR (both boxes are expressed as insets from the band's right edge)
// and they mount neither palette: the theme-independence of the ink is argued
// from its SOURCE (a value off the accent palette, which no palette override
// reaches), and the computed reading in both palettes is the proof round's on
// the live boot. What they do catch is exactly the two omissions the proof
// round measured — remove the overlay's ink or the column's reserve and the
// corresponding case fails.
//
// HOW THE GEOMETRY IS MEASURED HERE. jsdom lays nothing out, so the two boxes
// are reconstructed from what actually renders: the banner's own padding, the
// overlay's corner offset, the control's size and the name column's reserved
// trailing space, all read off the mounted nodes and expressed as insets from
// the band's right edge. The title's box may not reach into the control's box.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  CardFaceSwitcher,
  InstallPanelCloseButton,
  InstallPanelOpenButton,
} from "@cinatra-ai/extensions/screens/card-face-switcher";
import { MarketplaceListingCardInstallFace } from "@cinatra-ai/extensions/screens/marketplace-listing-card";
import type { MarketplaceCardData } from "@cinatra-ai/extensions/screens/marketplace-card-model";
import { ACCENT_PALETTE } from "@/lib/extension-accent";

/**
 * `italic-overhang-safe` on the name lets its final right-leaning glyph paint
 * 0.08em past its own margin box — the utility hands its padding back with an
 * equal negative margin — so the reserve has to clear the control's box by that
 * much as well. At the drawn 18px listing title that is under 1.5px.
 */
const NAME_INK_OVERHANG_PX = Math.ceil(0.08 * 18);

/** The E15 string the issue was filed on. */
const LONG_TITLE = "Google Appointment Schedules";
const SHORT_TITLE = "Ledger Sync";
const ACCENT = "olive" as const;

function cardData(displayName: string): MarketplaceCardData {
  return {
    packageName: "@cinatra-ai/google-appointment-schedules",
    packageVersion: "0.1.0",
    displayName,
    description: "Books, moves and cancels appointments on your team calendars.",
    kindSlug: "connector",
    kindLabel: "Connector",
    badge: { text: "Free", variant: "free" },
    freshnessAt: "2026-06-01T00:00:00Z",
    rating: { average: 4.6, count: 124 },
    detailHref: "/configuration/marketplace/cinatra-ai/google-appointment-schedules",
    installCount: 880,
    manifestLogoUrl: null,
    iconSlug: null,
    iconUrl: null,
    vendorLogoUrl: null,
    sdkAbiRange: null,
    vendor: null,
  };
}

/** Mounts the REAL install face behind the REAL switcher and opens it. */
function openInstallFace(displayName: string) {
  render(
    <CardFaceSwitcher
      idleFace={
        <div data-testid="idle-face">
          <InstallPanelOpenButton>Install now</InstallPanelOpenButton>
        </div>
      }
      installFace={
        <MarketplaceListingCardInstallFace
          card={cardData(displayName)}
          accentColor={ACCENT}
          closeControl={<InstallPanelCloseButton />}
        >
          <div data-testid="panel-body" />
        </MarketplaceListingCardInstallFace>
      }
    />,
  );
  fireEvent.click(screen.getByTestId("extension-install-panel-open"));
  const close = screen.getByTestId("extension-install-panel-close");
  const name = document.querySelector<HTMLElement>('[data-slot="extension-card-name"]');
  const icon = document.querySelector<HTMLElement>('[data-slot="extension-card-icon"]');
  expect(name, "the install face renders the card's name in the header band").not.toBeNull();
  expect(icon, "the install face renders the banner's icon tile").not.toBeNull();
  return {
    close,
    // The ✕'s own absolutely-positioned overlay wrapper.
    overlay: close.parentElement as HTMLElement,
    // The banner root — the icon tile's own parent.
    banner: icon!.parentElement as HTMLElement,
    name: name!,
    // The name + byline column.
    nameColumn: name!.parentElement as HTMLElement,
  };
}

/**
 * The colour `currentColor` resolves to for `el`: the nearest ancestor on its
 * own path that declares one. Returns "" when nothing on the path does — the
 * defect's own signature, since the band's ink then never reaches the mark.
 */
function resolvedCurrentColor(el: HTMLElement): string {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (node.style.color) return node.style.color;
  }
  return "";
}

/** jsdom's own normalisation of a colour literal, so hex and rgb() compare. */
function asRenderedColor(value: string): string {
  const probe = document.createElement("span");
  probe.style.color = value;
  return probe.style.color;
}

/**
 * The capture of the first WHOLE class token that matches — never a substring
 * of another utility (the shared Button carries
 * `[&_svg:not([class*='size-'])]:size-4`, which a loose `size-\d` match reads
 * as the control's own box).
 */
function twToken(className: string, pattern: RegExp): string {
  const token = className.split(/\s+/).find((t) => pattern.test(t));
  expect(token, `${pattern} must match a class token of: ${className}`).toBeTruthy();
  return token!.match(pattern)![1];
}

/** A Tailwind spacing unit is 4px (`right-2.5` → 10px, `size-6` → 24px). */
function twSpacingPx(className: string, pattern: RegExp): number {
  return Number.parseFloat(twToken(className, pattern)) * 4;
}

/** An arbitrary-value utility already carries its px (`p-[14px]` → 14). */
function twArbitraryPx(className: string, pattern: RegExp): number {
  return Number.parseFloat(twToken(className, pattern));
}

/**
 * An UNCONDITIONAL class token that would give the mark a NAMED ink of its own
 * (a token, palette or arbitrary colour) instead of the `text-current`
 * identity. Font-size and alignment utilities are not inks and do not match,
 * and a variant-prefixed token is not unconditional — the shared Button's base
 * carries `aria-expanded:text-foreground`, a state this mark never enters (it
 * is a close control, not a disclosure trigger; the case below pins that it
 * exposes no `aria-expanded` at all).
 */
const UNCONDITIONAL_COLOUR_UTILITY =
  /^text-(?:foreground|background|muted|primary|secondary|accent|destructive|card|popover|ring|border|input|surface|white|black|inherit|transparent|\[|[a-z]+-\d{2,3})/;

function pxValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

afterEach(() => cleanup());

describe('#2737 — the close ✕ takes the drawn band ink, in BOTH palettes', () => {
  it("resolves currentColor to the banner's own foreground, not the page's ink", () => {
    const { close } = openInstallFace(LONG_TITLE);
    const ink = resolvedCurrentColor(close);
    expect(
      ink,
      "nothing on the mark's ancestor path declares a colour, so its strokes take whatever ink the page carries — dark in the light palette, over a band that is the same colour in both",
    ).not.toBe("");
    expect(asRenderedColor(ink)).toBe(asRenderedColor(ACCENT_PALETTE[ACCENT].fg));
    // The walk above reads inline declarations only — no stylesheet is loaded
    // here — so it would stay green if the control itself later took a named
    // ink from a utility class. `text-current` is the identity and must remain
    // the ONLY colour utility the mark carries, or the band's ink stops being
    // what its strokes paint in.
    expect(close.className.split(/\s+/)).toContain("text-current");
    expect(
      close.className
        .split(/\s+/)
        .filter((token) => UNCONDITIONAL_COLOUR_UTILITY.test(token)),
      "the mark must keep `currentColor` as its ink, so the band's own colour reaches it",
    ).toEqual([]);
    expect(
      close.getAttribute("aria-expanded"),
      "the only named ink on the shared Button's base is `aria-expanded:text-foreground`; the mark is not a disclosure trigger, so it never applies",
    ).toBeNull();
  });

  it("takes that ink from the accent palette, so the theme cannot flip it", () => {
    const { close, banner } = openInstallFace(LONG_TITLE);
    // The band's name and byline take the SAME ink through the banner's own
    // inline style; the mark must read off the same single source, so no
    // palette override can move one without the other.
    expect(asRenderedColor(banner.style.color)).toBe(
      asRenderedColor(ACCENT_PALETTE[ACCENT].fg),
    );
    expect(asRenderedColor(resolvedCurrentColor(close))).toBe(
      asRenderedColor(banner.style.color),
    );
  });

  it("keeps the drawn 24px box, corner offset and 0.85 opacity", () => {
    const { close, overlay } = openInstallFace(LONG_TITLE);
    expect(twSpacingPx(close.className, /^size-(\d+(?:\.\d+)?)$/)).toBe(24);
    expect(twSpacingPx(overlay.className, /^right-(\d+(?:\.\d+)?)$/)).toBe(10);
    expect(twSpacingPx(overlay.className, /^top-(\d+(?:\.\d+)?)$/)).toBe(10);
    expect(close.className).toMatch(/\bopacity-85\b/);
  });
});

describe("#2737 — the title reserves the close control's trailing space", () => {
  for (const title of [LONG_TITLE, SHORT_TITLE]) {
    it(`keeps the title's box clear of the ✕'s box — "${title}"`, () => {
      const { close, overlay, banner, name, nameColumn } = openInstallFace(title);
      expect(name.className).toContain("italic-overhang-safe");

      // Both boxes as insets from the band's own right edge.
      const bannerPadEnd = twArbitraryPx(banner.className, /^p-\[(\d+)px\]$/);
      const reserved = pxValue(nameColumn.style.paddingInlineEnd);
      const titleBoxInset = bannerPadEnd + reserved;

      const controlBoxInset =
        twSpacingPx(overlay.className, /^right-(\d+(?:\.\d+)?)$/) +
        twSpacingPx(close.className, /^size-(\d+(?:\.\d+)?)$/);

      expect(controlBoxInset).toBe(34);
      expect(
        titleBoxInset,
        "the title reserves no trailing space, so the ✕ collides with a long title in the header band",
      ).toBeGreaterThanOrEqual(controlBoxInset + NAME_INK_OVERHANG_PX);
    });
  }

  it("reserves the same space whichever title it carries, so the row never jumps", () => {
    const { nameColumn: long } = openInstallFace(LONG_TITLE);
    const reservedLong = pxValue(long.style.paddingInlineEnd);
    cleanup();
    const { nameColumn: short } = openInstallFace(SHORT_TITLE);
    expect(pxValue(short.style.paddingInlineEnd)).toBe(reservedLong);
  });

  it("leaves the idle face's own banner untouched — the ✕ exists only here", () => {
    render(
      <CardFaceSwitcher
        idleFace={
          <div data-testid="idle-face">
            <InstallPanelOpenButton>Install now</InstallPanelOpenButton>
          </div>
        }
        installFace={<div />}
      />,
    );
    expect(screen.queryByTestId("extension-install-panel-close")).toBeNull();
  });
});
