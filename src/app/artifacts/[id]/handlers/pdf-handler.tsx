"use client";

/**
 * PDF handler.
 *
 * Default path: `<embed type="application/pdf">` so the browser's bundled
 * PDF viewer handles rendering + scrolling. Range requests on the preview
 * route make this stream-friendly (browsers issue `Range: bytes=0-1`
 * first, then incremental ranges as the user scrolls). No heavy client JS.
 *
 * iOS inline fallback (#70): iOS WebKit does not render `<embed>` PDFs
 * inline (a single non-scrollable page or a download prompt instead). The
 * server page passes a UA-based `initialFallback` hint so known-iOS
 * clients never mount the `<embed>` at all; after hydration
 * `needsPdfInlineFallback` re-checks with the full client signal set
 * (iPadOS-as-Mac touch points + `navigator.pdfViewerEnabled`) and corrects
 * the hint in either direction.
 *
 * Per the "heavy components dynamically imported" guardrail, the
 * react-pdf viewer is loaded via `next/dynamic({ ssr: false })`: its chunk
 * (react-pdf + pdfjs) is fetched ONLY when the fallback actually renders,
 * so browsers on the `<embed>` path never download it.
 */
import { useSyncExternalStore } from "react";
import type { ReactElement } from "react";
import dynamic from "next/dynamic";

import { needsPdfInlineFallback } from "./pdf-inline-support";

// The capability signals cannot change within a session — subscribe is a
// no-op; `useSyncExternalStore` is only here so the server-snapshot →
// client-snapshot handoff happens through React's hydration-safe path
// (no setState-in-effect).
const subscribeNever = (): (() => void) => () => {};

function detectFallbackOnClient(): boolean {
  return needsPdfInlineFallback({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    pdfViewerEnabled:
      typeof navigator.pdfViewerEnabled === "boolean"
        ? navigator.pdfViewerEnabled
        : undefined,
  });
}

const PdfFallbackViewer = dynamic(() => import("./pdf-fallback-viewer"), {
  ssr: false,
  loading: () => (
    <article className="soft-panel rounded-card p-6">
      <p className="text-muted-foreground text-sm">Loading PDF preview…</p>
    </article>
  ),
});

export type PdfHandlerProps = {
  readonly previewHref: string;
  /** The `/content` endpoint — the fallback viewer's error-state download link. */
  readonly downloadHref: string;
  /**
   * Server-computed UA hint (`isIosUserAgent` on the request UA). Keeps
   * SSR and hydration consistent while sparing iOS the broken-embed
   * flash before the post-hydration capability check lands.
   */
  readonly initialFallback: boolean;
};

export function PdfHandler({
  previewHref,
  downloadHref,
  initialFallback,
}: PdfHandlerProps): ReactElement {
  // SSR + hydration render the server's UA hint; the first client pass
  // swaps to the full-signal detection (both snapshots are stable
  // primitives, so this can never loop).
  const useFallback = useSyncExternalStore(
    subscribeNever,
    detectFallbackOnClient,
    () => initialFallback,
  );

  if (useFallback) {
    return (
      <PdfFallbackViewer
        previewHref={previewHref}
        downloadHref={downloadHref}
      />
    );
  }

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
