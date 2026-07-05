import type { ReactNode } from "react";

import type { ShareNetwork } from "@/lib/marketplace-detail-view";

/**
 * Share-network brand glyphs for the marketplace detail share row, vendored
 * verbatim from the design spec §V "Extension detail (modal)" drawing
 * (facebook / x / pinterest / linkedin / telegram, 19px, `currentColor`).
 * Decorative: the surrounding link carries the accessible network name via
 * `aria-label`; every glyph here is `aria-hidden`.
 *
 * Lives under `src/components/svg-icons/` — the designated home for vendored
 * brand SVG paths (see scripts/design/allowlist-raw-colors.json).
 */

const SHARE_NETWORK_PATHS: Record<ShareNetwork, string> = {
  facebook:
    "M22 12a10 10 0 1 0-11.6 9.9v-7H7.9V12h2.5V 9.8c0-2.5 1.5-3.8 3.7-3.8 1.1 0 2.2.2 2.2.2l0 2.4h-1.2c-1.2 0-1.6.8-1.6 1.5V12h2.7l-.4 2.9h-2.3v7A10 10 0 0 0 22 12z",
  x: "M17.5 3h3l-6.6 7.5L21.7 21h-6l-4.7-6.1L5.6 21h-3l7-8L2.6 3h6.1l4.3 5.6L17.5 3zm-1 16h1.7L7.6 4.8H5.8L16.5 19z",
  pinterest:
    "M12 2C6.5 2 2 6.5 2 12c0 4.2 2.6 7.8 6.3 9.3-.1-.8-.2-2 0-2.9l1.2-5s-.3-.6-.3-1.5c0-1.4.8-2.5 1.9-2.5.9 0 1.3.7 1.3 1.5 0 .9-.6 2.2-.9 3.5-.2 1 .5 1.9 1.5 1.9 1.9 0 3.2-2.4 3.2-5.2 0-2.1-1.5-3.8-4.1-3.8-3 0-4.9 2.3-4.9 4.8 0 .9.3 1.5.7 2 .2.2.2.3.1.6l-.3 1c0 .3-.3.4-.5.3-1.4-.6-2-2.1-2-3.8 0-2.8 2.4-6.2 7-6.2 3.7 0 6.2 2.7 6.2 5.6 0 3.8-2.1 6.6-5.2 6.6-1 0-2-.6-2.4-1.2l-.6 2.5c-.2.8-.7 1.9-1.1 2.5.8.3 1.7.4 2.6.4 5.5 0 10-4.5 10-10S17.5 2 12 2z",
  linkedin:
    "M4.98 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM3 9h4v12H3V9zm6 0h3.8l0 1.7h.1c.5-1 1.8-2 3.7-2 3.9 0 4.6 2.6 4.6 5.9V21H17v-5c0-1.2 0-2.8-1.7-2.8s-2 1.3-2 2.7V21H9V9z",
  telegram:
    "M9.8 15.6 9.5 20c.5 0 .7-.2.9-.4l2.2-2.1 4.6 3.4c.8.5 1.4.2 1.7-.8l3-14.1c.3-1.2-.5-1.7-1.3-1.4L2.3 10c-1.2.5-1.2 1.1-.2 1.4l4.6 1.4 10.6-6.7c.5-.3 1-.1.6.2l-8.7 9.3z",
};

/** The §V share-row glyph for a network — 19px filled `currentColor` mark. */
export function shareNetworkGlyph(
  network: ShareNetwork,
  className = "size-[19px]",
): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d={SHARE_NETWORK_PATHS[network]} />
    </svg>
  );
}
