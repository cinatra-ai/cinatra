"use client";

/**
 * THE ONE SHARED PDF SHELL - the pdf branch of every mixed text-and-pdf display
 * (wave 2 of `PLAN: Agents Lifecycle (D) - Review`, cinatra#3090 / epic #3087).
 *
 * IN THE PLAN'S OWN WORDS: "the pdf reading is the embedded PDF previewer the
 * pdf extension already uses - the browser's own PDF view over the preview
 * address, and the download floor where there is nothing to preview - no inline
 * fallback viewer. One shared pdf shell around that previewer - an SDK-leaf
 * helper or a registry item - so seven extensions do not fork seven of them."
 *
 * WHAT IT IS. Two drawn readings and nothing between them:
 *
 *   THE EMBEDDED VIEWER. `<embed type="application/pdf">` over the host's
 *   authorized preview address, so the browser's own bundled PDF viewer does the
 *   rendering and the scrolling. Range requests on that address make it
 *   stream-friendly, and no heavy client code is shipped to read a document.
 *
 *   THE DOWNLOAD FLOOR. Where there is nothing to preview - no materialized
 *   representation at all, or an embed the engine refused to load - the shell
 *   draws the floor instead: the words the drawing gives it and the download
 *   affordance beside them. The affordance itself degrades to a plain note when
 *   there is nothing to download, so the panel is never blank in any state.
 *
 * WHAT IT IS NOT. It renders no PDF itself: no inline page renderer, no worker,
 * no document/page tree. A reading this shell cannot show is a floor, never a
 * second viewer - the plan took the inline fallback off this road, and the
 * package's own contract test refuses one back onto it.
 *
 * ON THE BYTE ROAD, AND SAYING SO. Every reading the shell draws carries the
 * road its addresses came in on (wave 3, cinatra#3091), so the island reading
 * and the first-party reading are told apart on the surface itself rather than
 * in the source that built them.
 *
 * A LEAF. React and nothing else. An artifact display outside this repository
 * may depend on it without pulling a host package in behind it, and it reads
 * only the host-supplied authorized addresses it is handed - never a host port,
 * never a fetch of its own.
 *
 * ONE CHROME, TRAVELLING TO EVERY SURFACE. The artifact's own page, the review
 * card pending and settled, and the run page draw THIS module, marked with the
 * slot it was drawn in. The compact slot clips instead of growing the card it
 * sits in; the full slot fills the panel. The two can differ in height and in
 * nothing else.
 */

import { useState } from "react";
import type { ReactElement } from "react";

import { DownloadLink } from "../ui/download-link";

/** The renderer slots a shared shell is drawn in. */
export type PdfShellSlot = "detail" | "preview";

/**
 * WHICH ROAD THE ADDRESSES CAME IN ON (wave 3, cinatra#3091).
 *
 * A display on an island is handed sealed, short-lived addresses; on a
 * first-party surface it is handed the host's session routes. The shell paints
 * whichever it was given and builds none of its own - but it SAYS which, on
 * every reading it draws, because a surface that cannot be asked which road it
 * is on is a surface whose blank plate cannot be told from its empty document.
 * `none` is the honest answer where a reading was handed no address at all.
 */
export type PdfShellByteRoad = "island" | "session" | "none";

/** Why a floor was drawn - closed and named, so a surface can say which. */
export type PdfShellFloorReason = "no-representation" | "preview-failed";

/** The resolved reading: the embedded viewer, or the floor beneath it. */
export type PdfShellView =
  | { kind: "embedded"; previewHref: string; downloadHref: string | null }
  | { kind: "floor"; reason: PdfShellFloorReason; downloadHref: string | null };

/**
 * AN ADDRESS IS AN ADDRESS ONLY WHEN IT CARRIES SOMETHING. A blank or
 * whitespace-only string is one a browser resolves to the page itself - it
 * paints the page inside the panel where a document belongs, and it offers the
 * page as a download. Every address the shell is handed is read through here
 * once, so neither a reading nor a caller of the resolver ever meets one.
 */
export function normalizePdfShellHref(href: string | null): string | null {
  if (href === null) {
    return null;
  }
  const trimmed = href.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * WHETHER THE FAILURE ON RECORD BELONGS TO THIS DOCUMENT. A failed embed is
 * remembered as the ADDRESS that failed, never as a bare flag: a surface that
 * reuses one shell instance for a second artifact or a second revision - the run
 * page walking its list, the review card moving to the next target - would
 * otherwise carry the first document's floor onto a document that previews
 * perfectly well, with no way back to the viewer short of a reload.
 */
export function pdfShellPreviewFailed(input: {
  readonly failedHref: string | null;
  readonly previewHref: string | null;
}): boolean {
  const failed = normalizePdfShellHref(input.failedHref);
  return failed !== null && failed === normalizePdfShellHref(input.previewHref);
}

/**
 * The whole branch, as a total function over the addresses the host authorized.
 *
 * AN EMPTY ADDRESS IS NOT AN ADDRESS. A blank string is one a browser resolves
 * to the page itself, which paints an empty panel where a floor belongs; it is
 * read here as nothing to preview, exactly like a missing representation.
 */
export function resolvePdfShellView(input: {
  readonly previewHref: string | null;
  readonly downloadHref: string | null;
  readonly previewFailed?: boolean;
}): PdfShellView {
  const previewHref = normalizePdfShellHref(input.previewHref);
  const downloadHref = normalizePdfShellHref(input.downloadHref);
  if (previewHref === null) {
    return { kind: "floor", reason: "no-representation", downloadHref };
  }
  if (input.previewFailed === true) {
    return { kind: "floor", reason: "preview-failed", downloadHref };
  }
  return { kind: "embedded", previewHref, downloadHref };
}

/**
 * What the floor says. Both reasons read the same sentence to the person - the
 * distinction is for the surface and the capture, not for the reader, who only
 * ever learns that this document is not previewable here and how to get it.
 */
const PDF_SHELL_FLOOR_MESSAGES: Readonly<Record<PdfShellFloorReason, string>> =
  Object.freeze({
    "no-representation": "This PDF cannot be previewed here.",
    "preview-failed": "This PDF cannot be previewed here.",
  });

export function pdfShellFloorMessage(reason: PdfShellFloorReason): string {
  return PDF_SHELL_FLOOR_MESSAGES[reason];
}

/**
 * The download affordance beneath the floor's sentence. It degrades to a plain
 * note rather than a dead link when there is nothing to download, so the panel
 * is never blank in any state.
 */
function PdfShellDownload({
  downloadHref,
}: {
  readonly downloadHref: string | null;
}): ReactElement {
  if (downloadHref === null || downloadHref === "") {
    return (
      <p className="text-muted-foreground text-sm">
        This document has no downloadable content.
      </p>
    );
  }
  return <DownloadLink href={downloadHref}>Download PDF</DownloadLink>;
}

/** The compact slot clips the document instead of growing the card it sits in. */
const COMPACT_EMBED_CLASSES = "h-72 w-full";
const FULL_EMBED_CLASSES = "h-[75vh] w-full";

export function PdfDetailShell({
  previewHref,
  downloadHref,
  slot,
  road,
  compact = slot === "preview",
}: {
  readonly previewHref: string | null;
  readonly downloadHref: string | null;
  readonly slot: PdfShellSlot;
  /**
   * THE ROAD, NAMED BY THE CALLER — and never guessed. A shell handed no road
   * knows none: it is handed addresses, not the road that built them. Where a
   * caller names none the shell stamps none, and that caller's own wrapper
   * stays the single place the road is asserted; a default here would put a
   * `session` stamp inside an `island` wrapper on one and the same reading.
   */
  readonly road?: PdfShellByteRoad;
  readonly compact?: boolean;
}): ReactElement {
  // A best-effort signal for engines that DO fire `<embed>` onError on a
  // malformed or unloadable document. Where an engine does not fire it, its own
  // in-embed error surface stands in - still not a blank panel.
  //
  // The ADDRESS that failed is what is remembered, not a flag: the same shell
  // instance is reused as a surface moves from one artifact or revision to the
  // next, and a flag would strand the next document on the first one's floor.
  const [failedHref, setFailedHref] = useState<string | null>(null);

  const view = resolvePdfShellView({
    previewHref,
    downloadHref,
    previewFailed: pdfShellPreviewFailed({ failedHref, previewHref }),
  });

  if (view.kind === "floor") {
    return (
      <article
        className="soft-panel rounded-card flex flex-col items-center gap-3 p-6 text-center"
        data-artifact-renderer="pdf-shell"
        data-slot={slot}
        {...(road ? { "data-byte-road": road } : {})}
        data-floor={view.reason}
        {...(compact ? { "data-compact": "true" } : {})}
      >
        <p className="text-muted-foreground text-sm">
          {pdfShellFloorMessage(view.reason)}
        </p>
        <PdfShellDownload downloadHref={view.downloadHref} />
      </article>
    );
  }

  return (
    <article
      className="soft-panel rounded-card overflow-hidden p-0"
      data-artifact-renderer="pdf-shell"
      data-slot={slot}
      {...(road ? { "data-byte-road": road } : {})}
      {...(compact ? { "data-compact": "true" } : {})}
    >
      <embed
        src={view.previewHref}
        type="application/pdf"
        className={compact ? COMPACT_EMBED_CLASSES : FULL_EMBED_CLASSES}
        aria-label="PDF preview"
        onError={() => setFailedHref(normalizePdfShellHref(previewHref))}
      />
    </article>
  );
}
