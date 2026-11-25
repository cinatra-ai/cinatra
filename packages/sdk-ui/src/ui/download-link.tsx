import type { ReactElement, ReactNode } from "react";

/**
 * The download affordance: a design-system-styled anchor with the arrow glyph
 * inline, for the never-blank floors that offer a document instead of drawing
 * it (the shared pdf shell is the first).
 *
 * It lives beside the vendored primitives because it is one: the raw anchor
 * belongs in this directory, and every caller outside it takes THIS component
 * rather than an anchor of its own.
 *
 * NO ROUTER, NO ICON LIBRARY. The glyph is inline and the anchor is plain, so a
 * display shipped by an extension can use it without pulling a framework router
 * or an icon package in behind it. Same-origin href only - the host builds the
 * address as an authorized, access-checked one.
 */
/**
 * THE OUTLINE BUTTON, SPELLED IN UTILITIES (specs/app-artifact-review.html,
 * `.btn.outline` with the floor's own `padding:5px 12px;font-size:12px`): a 1px
 * border in the strong line colour, a 7px radius, the surface fill, the ink
 * colour, medium weight, the glyph 7px from the words. Utilities and nothing
 * else, because a class this module names must exist in every document that
 * draws it - the review island's included - and a named component class that
 * no stylesheet defines draws a bare link at the body's size.
 */
const DOWNLOAD_LINK_CLASSES =
  "inline-flex items-center gap-[7px] rounded-[7px] border border-line-strong bg-surface px-3 py-[5px] text-xs font-medium text-foreground no-underline";

export function DownloadLink({
  href,
  children,
}: {
  readonly href: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <a href={href} download className={DOWNLOAD_LINK_CLASSES}>
      <svg
        data-icon="inline-start"
        aria-hidden="true"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      {children}
    </a>
  );
}
