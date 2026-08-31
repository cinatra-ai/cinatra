/* -------------------------------------------------------------------------- *
 * Overlay collision band (cinatra#3105)
 *
 * The app shell header is a sticky, full-width 4rem band at `z-[140]`
 * (src/components/app-shell.tsx), offset from the viewport top by the
 * impersonation banner's `--banner-height`. Popper-positioned overlay panels —
 * the select list, the dropdown menu, the popover — paint ABOVE it at `z-[160]`
 * by design (the stacking band is recorded in src/components/ui/tooltip.tsx).
 * That is only safe while such a panel never OCCUPIES the header band: with the
 * positioning engine's default boundary (the viewport, zero padding), a list
 * taller than the room under its trigger grew straight across the header and
 * hid the breadcrumb and the top-bar control.
 *
 * These two helpers are the single place that bound is expressed, so all three
 * panel families inherit it instead of each call site repeating it. They live in
 * their OWN module rather than beside `cn`: src/lib/utils.ts is the design
 * registry's `utils` item, copied byte-for-byte into every extension that
 * vendors a design primitive, and app-shell geometry has no business travelling
 * there. Pinned by
 * scripts/extensions/__tests__/vendor-extension-primitives.test.mjs.
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
