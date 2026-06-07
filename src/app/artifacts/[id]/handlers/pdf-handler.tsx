/**
 * PDF handler.
 *
 * Uses `<embed type="application/pdf">` so the browser's bundled PDF
 * viewer handles rendering + scrolling. Range requests on the preview
 * route make this stream-friendly (browsers issue `Range: bytes=0-1`
 * first, then incremental ranges as the user scrolls). No client JS
 * required — no `react-pdf` dependency.
 *
 * Per the "heavy components dynamically imported" guardrail: `<embed>`
 * is a browser built-in (not a JS bundle), so dynamic import is N/A.
 * A future migration to `react-pdf` (if iOS Safari falls back to a
 * download prompt) would need `next/dynamic({ssr:false})`.
 */
import type { ReactElement } from "react";

export type PdfHandlerProps = {
  readonly previewHref: string;
};

export function PdfHandler({ previewHref }: PdfHandlerProps): ReactElement {
  return (
    <article className="soft-panel rounded-card overflow-hidden p-0">
      <embed
        src={previewHref}
        type="application/pdf"
        // 75vh so the embed fills most of the viewport without forcing
        // the page to scroll; the embed's own viewer handles PDF
        // scrolling.
        className="h-[75vh] w-full"
        aria-label="PDF preview"
      />
    </article>
  );
}
