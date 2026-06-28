"use client";

/**
 * react-pdf inline fallback viewer (#70).
 *
 * Rendered ONLY when `needsPdfInlineFallback` says the browser cannot
 * render `<embed type="application/pdf">` inline (iOS WebKit; engines
 * reporting `navigator.pdfViewerEnabled === false`). The module — and the
 * react-pdf + pdfjs chunk behind it — is reached exclusively through
 * `next/dynamic({ ssr: false })` in `pdf-handler.tsx`, per the "heavy
 * components dynamically imported" guardrail: browsers on the `<embed>`
 * path never download it.
 *
 * Resource bounds (the preview route already caps PDFs at 100MB):
 *   - pages render in batches of PAGE_BATCH_SIZE behind a "Load more
 *     pages" button, so a long document cannot allocate unbounded canvas
 *     memory up front (pdf.js may still range-fetch ahead over the
 *     preview route's Range support — network, not canvas, bound);
 *   - `devicePixelRatio` is capped at 2 (iPhones report 3 — at preview
 *     width the visual difference is negligible and canvas memory is not);
 *   - text/annotation layers are disabled: a preview-only surface — this
 *     skips both react-pdf CSS imports and the per-page layer work. Full
 *     fidelity stays one click away via the Download button.
 */

// Import order matters: the polyfill MUST evaluate before react-pdf
// (pdfjs-dist 5.x needs `Promise.withResolvers` at module scope on the
// main thread; iOS Safari < 17.4 lacks it).
import "./pdf-promise-with-resolvers-polyfill";

import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import Link from "next/link";
import { Download } from "lucide-react";
import { Document, Page, pdfjs } from "react-pdf";

import { Button } from "@/components/ui/button";

// Same-version worker served from our own origin — NEVER a CDN (the app
// is auth-gated; remote viewer code is both a privacy and a supply-chain
// hazard). `new URL(..., import.meta.url)` is the pattern react-pdf
// documents for webpack and Turbopack alike: the bundler emits the worker
// as a static asset and rewrites the URL. `pdfjs-dist` is a direct
// dependency pinned to the exact version react-pdf itself depends on
// (parity-tested in pdf-inline-fallback.test.ts) so the API and worker
// can never drift apart.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

// Stable reference — react-pdf reloads the document whenever `options`
// changes identity. `withCredentials` is defensive: the preview route is
// same-origin (cookies flow either way), but an explicit opt-in keeps the
// auth-gated fetch working if the app is ever served behind a different
// credentials mode.
const DOCUMENT_OPTIONS = { withCredentials: true };

const PAGE_BATCH_SIZE = 10;

// Cap canvas backing-store resolution. react-pdf defaults to
// `window.devicePixelRatio` (3 on recent iPhones), which triples canvas
// memory per page for no visible gain at preview width.
const MAX_DEVICE_PIXEL_RATIO = 2;

export type PdfFallbackViewerProps = {
  readonly previewHref: string;
  /** The existing `/content` endpoint — passed in, never derived from previewHref. */
  readonly downloadHref: string;
};

export default function PdfFallbackViewer({
  previewHref,
  downloadHref,
}: PdfFallbackViewerProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number | undefined>(
    undefined,
  );
  const [numPages, setNumPages] = useState<number | null>(null);
  const [visiblePages, setVisiblePages] = useState(PAGE_BATCH_SIZE);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = (): void => {
      setContainerWidth(el.clientWidth > 0 ? el.clientWidth : undefined);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (failed) {
    return (
      <article className="soft-panel rounded-card flex flex-col items-center gap-3 p-6 text-center">
        <p className="text-muted-foreground text-sm">
          This PDF can&rsquo;t be previewed inline on this device.
        </p>
        <Button asChild variant="outline">
          <Link href={downloadHref} download>
            <Download data-icon="inline-start" aria-hidden="true" />
            Download PDF
          </Link>
        </Button>
      </article>
    );
  }

  const devicePixelRatio = Math.min(
    typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
    MAX_DEVICE_PIXEL_RATIO,
  );
  const renderedPages = Math.min(visiblePages, numPages ?? 0);

  return (
    <article className="soft-panel rounded-card overflow-hidden p-0">
      <div
        ref={containerRef}
        className="max-h-[75vh] overflow-y-auto"
        aria-label="PDF preview"
      >
        <Document
          file={previewHref}
          options={DOCUMENT_OPTIONS}
          onLoadSuccess={({ numPages: total }) => setNumPages(total)}
          onLoadError={() => setFailed(true)}
          onSourceError={() => setFailed(true)}
          loading={
            <p className="text-muted-foreground p-6 text-sm">Loading PDF…</p>
          }
          // `failed` handles the user-facing error path; this slot only
          // covers react-pdf's internal render between error and rerender.
          error={
            <p className="text-muted-foreground p-6 text-sm">
              This PDF can&rsquo;t be previewed inline on this device.
            </p>
          }
        >
          {Array.from({ length: renderedPages }, (_, index) => (
            <Page
              key={index + 1}
              pageNumber={index + 1}
              width={containerWidth}
              devicePixelRatio={devicePixelRatio}
              renderTextLayer={false}
              renderAnnotationLayer={false}
              loading={
                <p className="text-muted-foreground p-6 text-sm">
                  Loading page {index + 1}…
                </p>
              }
            />
          ))}
        </Document>
      </div>
      {numPages !== null && visiblePages < numPages ? (
        <div className="border-border flex justify-center border-t p-3">
          <Button
            variant="outline"
            onClick={() => setVisiblePages((count) => count + PAGE_BATCH_SIZE)}
          >
            Load more pages ({renderedPages} of {numPages})
          </Button>
        </div>
      ) : null}
    </article>
  );
}
