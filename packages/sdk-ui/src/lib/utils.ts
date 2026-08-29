import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge with the `@cinatra-ai/design` type-scale utilities
 * registered. The custom `text-*` font-size tokens are unknown to
 * tailwind-merge's default config, which classifies unknown `text-*` classes
 * as text-COLOR utilities — a later `text-foreground` would silently strip
 * `text-page-title-lg` from the class list. Keep in sync with the @theme
 * mapping in `@cinatra-ai/design/theme.css`.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        "text-page-title-sm",
        "text-page-title-md",
        "text-page-title-lg",
        "text-listing-title",
        "text-badge-xs",
        "text-badge-2xs",
      ],
      tracking: [
        "tracking-title-tight",
        "tracking-kicker",
        "tracking-kicker-wide",
        "tracking-page-label",
      ],
    },
  },
});

/**
 * `cn` — class-name composition helper used across the Cinatra design system.
 * Merges Tailwind v4 utility classes via `tailwind-merge` so later utilities
 * override earlier ones predictably, and accepts `clsx`-style conditional
 * inputs for `className` props.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/* -------------------------------------------------------------------------- *
 * Overlay collision band (cinatra#3105)
 *
 * The app shell's header is a sticky, full-width 4rem band at `z-[140]`
 * (src/components/app-shell.tsx), offset from the viewport top by the
 * impersonation banner's `--banner-height`. Popper-positioned overlay panels —
 * the select list, the dropdown menu, the popover — paint ABOVE it at `z-[160]`
 * by design (the stacking band is recorded in the host token layer).
 * That is only safe while such a panel never OCCUPIES the header's band: with
 * the positioning engine's default boundary (the viewport, zero padding), a
 * list taller than the room under its trigger grew straight across the header
 * and hid the breadcrumb and the top-bar control.
 *
 * These two helpers are the single place that bound is expressed, so all three
 * panel families inherit it instead of each call site repeating it. They live
 * here, beside `cn`, because every panel component already imports this module:
 * a separate module would add an edge to the ratcheted route graph for no gain.
 * -------------------------------------------------------------------------- */

/** The app-shell header band: `h-16` === 4rem === 64px. */
export const APP_HEADER_BAND_PX = 64;

/** Breathing room so a bounded panel never butts against an edge. */
export const OVERLAY_EDGE_GUTTER_PX = 8;

export interface OverlayCollisionPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * The impersonation banner's height, in px, read from the custom property it
 * sets on the document root (packages/permissions/src/impersonation-banner.tsx).
 * 0 when there is no banner — and on the server, where there is no document.
 */
export function readBannerHeightPx(): number {
  if (typeof document === "undefined") return 0;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--banner-height")
    .trim();
  const px = Number.parseFloat(raw);
  return Number.isFinite(px) && px > 0 ? px : 0;
}

/**
 * The collision padding an overlay panel is positioned within: the header band
 * (plus whatever the banner currently adds above it) is subtracted from the top
 * of the panel's boundary, so a panel that cannot fit below its trigger flips
 * or scrolls inside itself instead of growing across the header.
 *
 * Evaluated at render — i.e. when the panel opens, since these panels mount on
 * open — so a banner that appears or disappears is picked up on the next open.
 */
export function overlayCollisionPadding(
  bannerHeightPx: number = readBannerHeightPx(),
): OverlayCollisionPadding {
  const banner = Number.isFinite(bannerHeightPx) && bannerHeightPx > 0 ? bannerHeightPx : 0;
  return {
    top: APP_HEADER_BAND_PX + banner + OVERLAY_EDGE_GUTTER_PX,
    right: OVERLAY_EDGE_GUTTER_PX,
    bottom: OVERLAY_EDGE_GUTTER_PX,
    left: OVERLAY_EDGE_GUTTER_PX,
  };
}
