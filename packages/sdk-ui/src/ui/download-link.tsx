import type { ReactElement, ReactNode } from "react";

/**
 * The download affordance: a design-system-styled button with the words alone
 * (the design draws the floor's "Download PDF" with no glyph), for the
 * never-blank floors that offer a document instead of drawing it (the shared
 * pdf shell is the first).
 *
 * It lives beside the vendored primitives because it is one: the raw anchor
 * belongs in this directory, and every caller outside it takes THIS component
 * rather than an anchor of its own.
 *
 * NO ROUTER, NO ICON LIBRARY. The control is plain markup, so a display shipped
 * by an extension can use it without pulling a framework router or an icon
 * package in behind it. Same-origin href only - the host builds the
 * address as an authorized, access-checked one.
 */
/**
 * THE OUTLINE BUTTON, SPELLED IN UTILITIES (specs/app-artifact-review.html,
 * `.btn.outline` with the floor's own `padding:5px 12px;font-size:12px`): a 1px
 * border in the strong line colour, a 7px radius, the surface fill, the ink
 * colour, medium weight, and no glyph. Utilities and nothing
 * else, because a class this module names must exist in every document that
 * draws it - the review island's included - and a named component class that
 * no stylesheet defines draws a bare link at the body's size.
 */
const DOWNLOAD_LINK_CLASSES =
  "inline-flex cursor-pointer items-center gap-[7px] rounded-[7px] border border-line-strong bg-surface px-3 py-[5px] text-xs font-medium text-foreground no-underline";

/**
 * The design draws this control as a real button (specs/app-lifecycle-cards.html,
 * specs/app-artifact-review.html) so a keyboard reaches it and Enter or Space
 * presses it; its action anchor is the design's exact string. The press starts
 * the same download the anchor did: the same address, the same empty `download`
 * file-name hint (the host's Content-Disposition names the file).
 */
const DOWNLOAD_ACTION = "download-artifact -> file-downloaded";

function startDownload(href: string): void {
  const anchor = document.createElement("a");
  anchor.setAttribute("href", href);
  anchor.setAttribute("download", "");
  anchor.click();
}

export function DownloadLink({
  href,
  children,
}: {
  readonly href: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      data-action={DOWNLOAD_ACTION}
      data-href={href}
      className={DOWNLOAD_LINK_CLASSES}
      onClick={() => startDownload(href)}
    >
      {children}
    </button>
  );
}
