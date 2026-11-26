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
 *   representation at all, an embed the engine refused to load, or a frame the
 *   browser will not run its PDF viewer in - the shell draws the floor instead:
 *   the words the drawing gives it and the download affordance beside them. The
 *   affordance itself degrades to a plain note when there is nothing to
 *   download, so the panel is never blank in any state; and where a download
 *   cannot work from here (`readPdfShellDownloads`), the floor keeps its words
 *   and draws no affordance at all - never a control that does nothing.
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

import { createContext, useContext, useMemo, useState, useSyncExternalStore } from "react";
import type { ReactElement, ReactNode } from "react";

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
export type PdfShellFloorReason =
  | "no-representation"
  | "preview-failed"
  | "sandboxed-frame";

/**
 * WHETHER THE DOCUMENT SITS IN A FRAME THE BROWSER'S PDF VIEWER WILL RUN IN.
 *
 * Chromium never starts its bundled PDF viewer inside a sandboxed frame, and it
 * says nothing when it declines: the `<embed>` fires neither `load` nor `error`,
 * so the failure signal below never arrives and the panel stays blank. The
 * review card draws its target in exactly such a frame (the island iframe
 * carries a `sandbox` attribute). So the shell asks the frame first, and in a
 * sandboxed one it draws the floor - the words and the download - instead of an
 * embed that can only stay empty.
 */
export type PdfShellFrame = "sandboxed" | "unsandboxed";

/**
 * Bound on the ancestor walk. Real pages nest a handful of frames at most; a
 * walk that has not reached the top by here is treated as unreadable.
 */
const PDF_SHELL_FRAME_WALK_LIMIT = 16;

/** The part of a window the frame reading uses - so it can be read in a test. */
export interface PdfShellFrameWindow {
  readonly parent: PdfShellFrameWindow;
  readonly frameElement: {
    hasAttribute(name: string): boolean;
    getAttribute?(name: string): string | null;
  } | null;
}

/**
 * THE RULE. Walk from this document up to the top-level one:
 *
 *   - a document that is its own parent is the top: nothing above it is
 *     sandboxed, so the answer is `unsandboxed`;
 *   - an ancestor frame element that carries a `sandbox` attribute (any value,
 *     even empty) means `sandboxed` - sandbox flags are inherited by every
 *     frame nested inside it, so one sandboxed ancestor is enough;
 *   - a frame element we cannot read - `frameElement` is null although there
 *     is a parent (the parent is another origin), or the accessor throws - is
 *     read as `sandboxed`.
 *
 * WHY "CANNOT TELL" READS AS SANDBOXED. This application's pages declare
 * `frame-ancestors 'self'`; the only road that frames one cross-origin is the
 * widget, whose embedding site sandboxes its frame. So an unreadable parent is,
 * in practice, a sandboxed one. And the two mistakes are not equal: the floor in
 * a frame that could have shown the viewer still names the document and offers
 * its download, while the embed in a frame that cannot show it is a blank plate.
 */
export function readPdfShellFrame(win: PdfShellFrameWindow): PdfShellFrame {
  let current = win;
  for (let depth = 0; depth < PDF_SHELL_FRAME_WALK_LIMIT; depth += 1) {
    try {
      const parent = current.parent;
      if (parent === current) {
        return "unsandboxed";
      }
      const host = current.frameElement;
      if (host === null || host.hasAttribute("sandbox")) {
        return "sandboxed";
      }
      current = parent;
    } catch {
      return "sandboxed";
    }
  }
  return "sandboxed";
}

/**
 * WHETHER A DOWNLOAD STARTED IN THIS DOCUMENT CAN WORK.
 *
 * A download is subject to the sandbox of EVERY frame above the document: one
 * frame up the chain without `allow-downloads` blocks it, whether it starts from
 * a link or from a saved blob. So walk from this document up to the top-level
 * one:
 *
 *   - a document that is its own parent is the top: `allowed`;
 *   - a frame element with no `sandbox` attribute withholds nothing: go on up;
 *   - a frame element whose `sandbox` value lists `allow-downloads` (tokens are
 *     matched without regard to case, as the browser does): go on up;
 *   - a sandboxed frame element without that token: `blocked`;
 *   - a frame element we cannot read - `frameElement` is null although there is
 *     a parent (the parent is another origin), its sandbox value cannot be read,
 *     or an accessor throws - is `blocked`, because nothing proves the download
 *     can work. The widget's CMS frame is exactly such a parent.
 */
export type PdfShellDownloads = "allowed" | "blocked";

export function readPdfShellDownloads(win: PdfShellFrameWindow): PdfShellDownloads {
  let current = win;
  for (let depth = 0; depth < PDF_SHELL_FRAME_WALK_LIMIT; depth += 1) {
    try {
      const parent = current.parent;
      if (parent === current) {
        return "allowed";
      }
      const host = current.frameElement;
      if (host === null) {
        return "blocked";
      }
      if (host.hasAttribute("sandbox")) {
        const tokens = host.getAttribute?.("sandbox");
        if (typeof tokens !== "string") {
          return "blocked";
        }
        const allows = tokens
          .toLowerCase()
          .split(/\s+/)
          .includes("allow-downloads");
        if (!allows) {
          return "blocked";
        }
      }
      current = parent;
    } catch {
      return "blocked";
    }
  }
  return "blocked";
}

/**
 * WHETHER THE PAGE'S DOWNLOAD ADDRESSES TAKE A LINK, declared by the page that
 * serves the document - only the server knows which addresses it handed out.
 *
 *   - `link`: a plain download link to the address works - the host's session
 *     routes, which the first-party card's document is handed;
 *   - `none`: no download control may be drawn - the widget's sealed byte
 *     capabilities, whose serving route refuses a link navigation, inside a CMS
 *     frame the shell cannot read and whose sandbox withholds downloads.
 *
 * A page that declares nothing is a first-party page handed session routes, so
 * the default is `link`; the frame reading above still withholds the control
 * wherever a frame up the chain blocks the download or cannot be read.
 */
export type PdfShellDownloadRoad = "link" | "none";

/**
 * WHAT THE SERVER PAINTS, DECLARED BY THE PAGE THAT SERVES IT.
 *
 * A server render cannot see the frame its document will land in. Left alone it
 * paints the embed, the browser shows that empty embed until the page hydrates,
 * and only then would the client reading swap it for the floor. A page that is
 * ONLY ever served into a sandboxed frame - the review island - says so with
 * this provider, so its server render already draws the floor and the client
 * reading agrees on the first pass: no blank embed is ever painted, and the
 * hydrated markup matches the served markup.
 *
 * The declaration is only the first paint. Once the page runs, the shell reads
 * the frame it is actually in (`readPdfShellFrame`) and that reading decides.
 */
interface PdfShellFrameDeclaration {
  readonly frame: PdfShellFrame;
  readonly downloads: PdfShellDownloadRoad;
}

const PdfShellFrameContext = createContext<PdfShellFrameDeclaration>({
  frame: "unsandboxed",
  downloads: "link",
});

export function PdfShellFrameProvider({
  frame,
  downloads,
  children,
}: {
  readonly frame: PdfShellFrame;
  readonly downloads: PdfShellDownloadRoad;
  readonly children?: ReactNode;
}): ReactElement {
  const value = useMemo(() => ({ frame, downloads }), [frame, downloads]);
  return (
    <PdfShellFrameContext.Provider value={value}>
      {children}
    </PdfShellFrameContext.Provider>
  );
}

/** The frame never changes under a mounted document: nothing to subscribe to. */
function subscribeToNothing(): () => void {
  return () => undefined;
}

function readThisFrame(): PdfShellFrame {
  return readPdfShellFrame(window as unknown as PdfShellFrameWindow);
}

function readThisFrameDownloads(): PdfShellDownloads {
  return readPdfShellDownloads(window as unknown as PdfShellFrameWindow);
}

function assumeDownloadsAllowed(): PdfShellDownloads {
  return "allowed";
}

/**
 * The frame this shell draws in, and whether a download can work from it: the
 * page's declaration during the server render and hydration, and the frame's
 * own answer from then on. A mismatch between the two is a re-render, never a
 * hydration error.
 *
 * Downloads are offered only where BOTH hold: the page declared `link`
 * addresses, and (once the page runs) every frame up the chain can be read and
 * allows downloads. The server cannot read the chain, so it trusts the page's
 * declaration; a `none` declaration is final on the server and the client alike.
 */
function usePdfShellFrame(): { frame: PdfShellFrame; downloads: PdfShellDownloads } {
  const declared = useContext(PdfShellFrameContext);
  const frame = useSyncExternalStore(subscribeToNothing, readThisFrame, () => declared.frame);
  const chain = useSyncExternalStore(subscribeToNothing, readThisFrameDownloads, assumeDownloadsAllowed);
  return { frame, downloads: declared.downloads === "link" && chain === "allowed" ? "allowed" : "blocked" };
}

/** The resolved reading: the embedded viewer, or the floor beneath it. */
export type PdfShellView =
  | { kind: "embedded"; previewHref: string; downloadHref: string | null }
  | {
      kind: "floor";
      reason: PdfShellFloorReason;
      downloadHref: string | null;
      /** Present only where a download cannot work from here: draw no control. */
      download?: "blocked";
    };

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
  readonly frame?: PdfShellFrame;
  readonly downloads?: PdfShellDownloads;
}): PdfShellView {
  const previewHref = normalizePdfShellHref(input.previewHref);
  const downloadHref = normalizePdfShellHref(input.downloadHref);
  // THE RULE, in order: no address to preview, or a sandboxed frame, or a failed
  // embed is the floor; anything else is the embedded viewer. A floor offers
  // its download only where downloads are not blocked - a blocked floor carries
  // no address at all, so nothing downstream can draw a link to it.
  const floor = (reason: PdfShellFloorReason): PdfShellView =>
    input.downloads === "blocked"
      ? { kind: "floor", reason, downloadHref: null, download: "blocked" }
      : { kind: "floor", reason, downloadHref };
  if (previewHref === null) {
    return floor("no-representation");
  }
  if (input.frame === "sandboxed") {
    return floor("sandboxed-frame");
  }
  if (input.previewFailed === true) {
    return floor("preview-failed");
  }
  return { kind: "embedded", previewHref, downloadHref };
}

/**
 * What the floor says. Every reason reads the same sentence to the person - the
 * distinction is for the surface and the capture, not for the reader, who only
 * ever learns that this document is not previewable here and how to get it.
 */
const PDF_SHELL_FLOOR_MESSAGES: Readonly<Record<PdfShellFloorReason, string>> =
  Object.freeze({
    "no-representation": "This PDF cannot be previewed here.",
    "preview-failed": "This PDF cannot be previewed here.",
    "sandboxed-frame": "This PDF cannot be previewed here.",
  });

export function pdfShellFloorMessage(reason: PdfShellFloorReason): string {
  return PDF_SHELL_FLOOR_MESSAGES[reason];
}

/**
 * THE FLOOR IS ONE SURFACE (specs/app-artifact-review.html §XI.2 / §XI.4, the
 * floor drawing): it sits straight under the target header in the panel the
 * header opens, with a rule above it and nothing around it - a 1px top border
 * in the line colour, 22px above and below, 14px at the sides, the sentence
 * and the control centred 10px apart. It draws no border of its own on the
 * other three sides, no radius and no fill: a rounded, bordered panel here is
 * the nested body card §IV does not draw.
 */
const PDF_SHELL_FLOOR_CLASSES =
  "flex flex-col items-center gap-[10px] border-t border-line px-[14px] py-[22px] text-center";

/** The floor's sentence: 12px in the muted colour, with no margin of its own. */
const PDF_SHELL_FLOOR_SENTENCE_CLASSES = "m-0 text-xs text-muted-foreground";

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
      <p className={PDF_SHELL_FLOOR_SENTENCE_CLASSES}>
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
  const { frame, downloads } = usePdfShellFrame();

  const view = resolvePdfShellView({
    previewHref,
    downloadHref,
    previewFailed: pdfShellPreviewFailed({ failedHref, previewHref }),
    frame,
    downloads,
  });

  if (view.kind === "floor") {
    return (
      <article
        className={PDF_SHELL_FLOOR_CLASSES}
        data-artifact-renderer="pdf-shell"
        data-slot={slot}
        {...(road ? { "data-byte-road": road } : {})}
        data-floor={view.reason}
        {...(compact ? { "data-compact": "true" } : {})}
      >
        <p className={PDF_SHELL_FLOOR_SENTENCE_CLASSES}>
          {pdfShellFloorMessage(view.reason)}
        </p>
        {view.download === "blocked" ? null : (
          <PdfShellDownload downloadHref={view.downloadHref} />
        )}
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
