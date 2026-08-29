import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function formatCurrencyMillions(value?: number | null) {
  if (value === undefined || value === null || Number.isNaN(value)) {
    return "Undisclosed";
  }

  return `$${value.toFixed(2)}M`;
}

export function firstName(fullName?: string) {
  if (!fullName) {
    return undefined;
  }

  return fullName.split(/\s+/)[0];
}

export function quarterLabel(quarterId: string) {
  return quarterId.replace("-", " ");
}

export function asArray(value: string | string[] | undefined) {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

export function compareValues(a: string | number | null | undefined, b: string | number | null | undefined) {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }

  return String(a ?? "").localeCompare(String(b ?? ""), undefined, { sensitivity: "base" });
}

export function getPageNumbers(
  currentPage: number,
  totalPages: number
): (number | '...')[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  if (currentPage <= 4) {
    return [1, 2, 3, 4, 5, '...', totalPages];
  }
  if (currentPage >= totalPages - 3) {
    return [1, '...', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  }
  return [1, '...', currentPage - 1, currentPage, currentPage + 1, '...', totalPages];
}

/* -------------------------------------------------------------------------- *
 * Overlay collision band (cinatra#3105)
 *
 * The app shell's header is a sticky, full-width 4rem band at `z-[140]`
 * (src/components/app-shell.tsx), offset from the viewport top by the
 * impersonation banner's `--banner-height`. Popper-positioned overlay panels —
 * the select list, the dropdown menu, the popover — paint ABOVE it at `z-[160]`
 * by design (the stacking band is recorded in src/components/ui/tooltip.tsx).
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
