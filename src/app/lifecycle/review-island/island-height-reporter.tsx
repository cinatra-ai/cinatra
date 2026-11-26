"use client";

// THE REPORTER — the client half of the island's height (the twelfth proof
// round's counted defect on cinatra#3143, 2026-09-10). See
// `island-height-report.ts` for what crosses and why the measurement walks the
// content rather than reading `scrollHeight`.
//
// It is mounted as the LAST child of the island body and draws nothing: a
// hidden marker, which is how it finds the container it measures and how the
// measurement knows to leave itself out. `hidden` keeps it out of the flex flow
// entirely, so it adds neither a row nor a gap to the work it is measuring.
//
// The island stays display-only. This posts ONE NUMBER to the frame that holds
// it, at its own origin, and offers the host nothing to call.

import { useEffect, useId, useRef } from "react";
import type { ReactElement, ReactNode } from "react";

import { islandContentHeight, reviewIslandHeightMessage, parseReviewIslandFrameName, reviewIslandDrawnMessage, reviewIslandProgressMessage, type ReviewIslandProgressType } from "./island-height-report";
import { islandPaletteClass } from "./island-color-scheme";
import { parseReviewIslandPalette } from "./island-palette-message";

export function IslandHeightReporter(): ReactElement {
  const marker = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const self = marker.current;
    const container = self?.parentElement ?? null;
    const view = container?.ownerDocument?.defaultView ?? null;
    // Not framed — the island opened directly. There is nobody to tell.
    if (!container || !view || view.parent === view) return;

    // Repaint the current work while a palette-address navigation is arriving.
    // Neither another frame nor a foreign origin may repaint this island.
    const onPalette = (event: MessageEvent) => {
      if (event.origin !== view.location.origin || event.source !== view.parent) return;
      const scheme = parseReviewIslandPalette(event.data);
      if (scheme === null) return;
      container.classList.remove("cinatra", "dark");
      container.classList.add(islandPaletteClass(scheme), "min-h-dvh", "text-foreground");
      container.dataset.islandColorScheme = scheme;
      container.style.colorScheme = scheme;
      container.ownerDocument.documentElement.style.colorScheme = scheme;
    };
    view.addEventListener("message", onPalette);

    let last = -1;
    const report = () => {
      const height = islandContentHeight(container, self);
      if (height <= 0 || height === last) return;
      last = height;
      view.parent.postMessage(reviewIslandHeightMessage(height), view.location.origin);
    };

    // The container's own box only changes while the work is TALLER than
    // `min-h-dvh`, so the children are observed too — that is the arm that sees
    // a Suspense fallback settle into something shorter than itself.
    const sizes =
      typeof view.ResizeObserver === "function" ? new view.ResizeObserver(report) : null;
    const observeWork = () => {
      if (!sizes) return;
      sizes.disconnect();
      sizes.observe(container);
      for (const child of Array.from(container.children)) {
        if (child !== self) sizes.observe(child);
      }
    };
    observeWork();

    // A panel arriving or leaving is a new child, which no existing observation
    // covers — re-observe, then measure.
    const children =
      typeof view.MutationObserver === "function"
        ? new view.MutationObserver(() => {
            observeWork();
            report();
          })
        : null;
    children?.observe(container, { childList: true, subtree: true });

    // Fonts and images settle after the first paint and both move the work.
    const onLoad = () => report();
    view.addEventListener("load", onLoad);
    report();

    return () => {
      sizes?.disconnect();
      children?.disconnect();
      view.removeEventListener("load", onLoad);
      view.removeEventListener("message", onPalette);
    };
  }, []);

  return (
    <span
      ref={marker}
      hidden
      aria-hidden="true"
      data-conformance-id="review-target-island-height-reporter"
    />
  );
}

function postProgress(type: ReviewIslandProgressType): void {
  if (typeof window === "undefined") return;
  // The card's stamp on THIS frame. A document nobody framed — or one framed by
  // something that is not the card — has no attempt to name and stays silent.
  const attempt = parseReviewIslandFrameName(window.name);
  if (attempt === null) return;
  // `*`, deliberately: the message is data-free (the channel, the event and the
  // attempt), and this document is never told the origin of the surface that
  // frames it — first-party it is the app's own, inside the widget it is a
  // third-party site's. The card is the side that checks provenance, and it
  // checks all three of origin, source frame and attempt.
  window.parent.postMessage(reviewIslandProgressMessage(type, attempt), "*");
}

// THE DRAWN READING (cinatra#3089): the panels this document was given, each
// mounted panel's own reading, and what the document last told the card. One
// document holds one island, so module state is that document's; a Map keyed by
// each signal's own id counts a panel once even when its effect runs twice.
type PanelReading = "loading" | "drawn" | "failed";
const drawnState: {
  expected: number | null;
  panels: Map<string, PanelReading>;
  /** What the card was last told: nothing yet or busy (`waiting`), `drawn`, or `failed` (final). */
  told: "waiting" | "drawn" | "failed";
  settle: ReturnType<typeof setTimeout> | null;
} = { expected: null, panels: new Map(), told: "waiting", settle: null };

/**
 * THE SETTLE BOUND: the document reports drawn only once every panel has read drawn, with no change to its content
 * (a node added, removed or its text changed) and no change of its reading, for this long. A display that commits an unmarked placeholder and marks itself busy on the next tick, or that toggles
 * busy quickly, therefore never makes Allow live in between. Busy and failed are reported at once: the safe side.
 */
export const ISLAND_DRAWN_SETTLE_MS = 250;

function frameAttempt(): number | null {
  if (typeof window === "undefined") return null;
  return parseReviewIslandFrameName(window.name);
}

function documentReading(): PanelReading {
  const { expected, panels } = drawnState;
  let drawn = 0;
  for (const reading of panels.values()) {
    if (reading === "failed") return "failed";
    if (reading === "drawn") drawn += 1;
  }
  if (expected === null || drawn < expected || drawn < panels.size) return "loading";
  return "drawn";
}

function clearSettle(): void {
  if (drawnState.settle !== null) clearTimeout(drawnState.settle);
  drawnState.settle = null;
}

/**
 * A PANEL'S CONTENT CHANGED (cinatra#3089): a node was added, removed or its text changed. The renderer ABI carries
 * no completion signal, so a change is the only word the host gets that a display is still drawing: the quiet period
 * starts again, and content replaced after the drawn report is reported busy at once (Allow waits) until the new
 * content has held for the quiet period and is reported drawn again.
 */
function contentChanged(): void {
  clearSettle();
  if (drawnState.told !== "drawn") return;
  drawnState.told = "waiting";
  postProgress("island-busy");
}

/** Tell the card what the document reads now (see `ISLAND_DRAWN_SETTLE_MS`). */
function reportDocument(): void {
  if (drawnState.told === "failed") return;
  const reading = documentReading();
  if (reading === "failed") {
    clearSettle();
    drawnState.told = "failed";
    postProgress("island-failed");
    return;
  }
  if (reading === "loading") {
    clearSettle();
    if (drawnState.told === "drawn") {
      drawnState.told = "waiting";
      postProgress("island-busy");
    }
    return;
  }
  if (drawnState.told === "drawn" || drawnState.settle !== null) return;
  drawnState.settle = setTimeout(() => {
    drawnState.settle = null;
    if (drawnState.told !== "waiting" || documentReading() !== "drawn") return;
    const attempt = frameAttempt();
    if (attempt === null) return;
    drawnState.told = "drawn";
    // `*` for the reason given in `postProgress`: the card checks provenance.
    window.parent.postMessage(reviewIslandDrawnMessage(attempt, drawnState.expected ?? 0), "*");
  }, ISLAND_DRAWN_SETTLE_MS);
}

/**
 * "The island document is answering." Posted BEFORE any panel work — it is the
 * first child of the body — so the card can cancel its initial-response bound
 * and start watching for progress instead.
 *
 * `panels` (cinatra#3089) is how many panels this document draws: once that many
 * read drawn it posts `island-drawn` with the count (0 at once, for the one
 * empty document). Omitted, nothing is reported as drawn.
 */
export function IslandReadySignal({ panels }: { panels?: number } = {}): null {
  useEffect(() => {
    if (panels === undefined) {
      postProgress("island-ready");
      return;
    }
    drawnState.expected = panels;
    if (panels > 0) {
      postProgress("island-ready");
      reportDocument();
      return;
    }
    // The one empty document: nothing can still be loading, so it is told at once.
    const attempt = frameAttempt();
    if (attempt === null || drawnState.told !== "waiting") return;
    drawnState.told = "drawn";
    window.parent.postMessage(reviewIslandDrawnMessage(attempt, 0), "*");
  }, [panels]);
  return null;
}

/** The marks a display leaves when it fell to its floor instead of drawing the item: the review mount's floor, the
 *  runtime loader's floor and the build-map slot's degraded notice. */
const PANEL_FLOOR_SELECTOR = "[data-review-target-floor],[data-dynamic-renderer-floor],[data-render-failure-class]";

/** The marks of a display that is not finished drawing (the display contract below), and the dashboard library's own
 *  unmarked placeholders. drizzle-cube (0.6.6, the version `@cinatra-ai/sdk-dashboard` pins) draws three not-yet-drawn
 *  states of a portlet as one EMPTY `div` carrying its `dc:animate-pulse` class, with no ARIA mark: the portlet before
 *  it scrolls into view (its lazy placeholder) and the fallback while a chart's code loads (twice). Its loading state
 *  draws a `role="status"` spinner, read by the contract's own mark. The class is the library's prefixed one, which
 *  no host skeleton uses (those are `animate-pulse`), and an empty element of it is never drawn content. */
const PANEL_BUSY_SELECTOR = '[aria-busy="true"],[role="status"],[class~="dc:animate-pulse"]:empty';

type MediaReading = "loading" | "loaded" | "failed";

/**
 * WHAT ONE PANEL'S OWN CONTENT READS (cinatra#3089): drawn only once every item of it has finished loading
 * successfully. One rule for every kind the panel can hold:
 *   - a display that fell to its floor: failed (the item itself is not on screen);
 *   - a display that is not finished drawing: loading. THE DISPLAY CONTRACT: a display (the host's own or one an
 *     extension ships, `cinatra.artifact.ui`) that has not finished drawing marks its root or the unfinished part
 *     `aria-busy="true"`, or renders an element with `role="status"` while it loads (the runtime loader's skeleton,
 *     the dashboard composition's chart spinner), and removes the mark once its content is drawn; a display that
 *     cannot draw shows its failure state. `role="status"` therefore means "still loading" inside a panel: a
 *     display keeps a settled message out of it (a live region with `aria-live="polite"` instead). This is the only
 *     way a display can say it is not finished. Without a mark the host reads what it sees: an empty panel never reads
 *     drawn (`panelHasContent`), and content that is still changing restarts the settle bound (`contentChanged`), so
 *     an unmarked display reads drawn once it shows content that has held for the settle bound;
 *   - an image (an image representation's preview, a pinned capture, an image a display draws): its own decode
 *     promise answers, `img.decode()`, which settles once the bytes loaded and decoded, and rejects on a failed
 *     request; a failed image is failed; an image whose `src` changes is read again;
 *   - a video: loaded at `readyState >= HAVE_CURRENT_DATA`, failed when it carries an `error`;
 *   - text, a structured-data view, a table: drawn once mounted (React committed it before this effect runs).
 * `media` holds each image's and video's settled reading.
 */
function readPanelContent(root: Element, media: Map<Element, MediaReading>): PanelReading {
  if (root.querySelector(PANEL_FLOOR_SELECTOR)) return "failed";
  let loading = root.querySelector(PANEL_BUSY_SELECTOR) !== null || !panelHasContent(root);
  for (const element of root.querySelectorAll("img, video")) {
    const reading = media.get(element) ?? "loading";
    if (reading === "failed") return "failed";
    if (reading === "loading") loading = true;
  }
  return loading ? "loading" : "drawn";
}

/** What a panel can draw as content: a picture, a video, a vector or bitmap drawing, an embedded document. */
const PANEL_CONTENT_SELECTOR = "img,video,svg,canvas,picture,object,embed,iframe";

/**
 * AN EMPTY PANEL IS NEVER DRAWN (cinatra#3089). A display may first commit an empty placeholder and draw its snapshot
 * later, and the renderer ABI gives it no word for "finished". So the host reads drawn only what it can see: the
 * representation slot (the whole panel where there is no slot) holds text or a drawn element. An empty slot reads
 * loading, and the card's idle bound turns one that stays empty into the failed reading.
 */
function panelHasContent(root: Element): boolean {
  const slot = root.querySelector("[data-review-representation-slot]") ?? root;
  return (slot.textContent ?? "").trim() !== "" || slot.querySelector(PANEL_CONTENT_SELECTOR) !== null;
}

/** Start reading each image and video under `root` that has no reading yet, recording its settled reading in
 *  `media`; `changed` runs whenever one settles. A reading is dropped when its element's `src` changes. */
function watchMedia(root: Element, media: Map<Element, MediaReading>, changed: () => void): void {
  for (const element of root.querySelectorAll("img, video")) {
    if (media.has(element)) continue;
    media.set(element, "loading");
    const src = element.getAttribute("src");
    const settle = (reading: MediaReading) => {
      // A reading of an earlier `src` (or of an element already read again) is not this element's reading.
      if (media.get(element) !== "loading" || element.getAttribute("src") !== src) return;
      media.set(element, reading);
      changed();
    };
    if (element instanceof HTMLImageElement) {
      if (typeof element.decode === "function") {
        element.decode().then(() => settle("loaded"), () => settle("failed"));
      } else {
        // No decode (an old engine): the image's own events, or its state when it already settled.
        if (element.complete) settle(element.naturalWidth > 0 ? "loaded" : "failed");
        element.addEventListener("load", () => settle("loaded"), { once: true });
        element.addEventListener("error", () => settle("failed"), { once: true });
      }
    } else if (element instanceof HTMLVideoElement) {
      if (element.error) settle("failed");
      else if (element.readyState >= 2) settle("loaded");
      element.addEventListener("loadeddata", () => settle("loaded"), { once: true });
      element.addEventListener("error", () => settle("failed"), { once: true });
    }
  }
}

/**
 * "A panel arrived", and later "its items are drawn". Wraps one target's panel (a `display: contents` box, so the
 * island body's layout is unchanged). On mount it posts `panel-mounted`, which restarts the card's idle-progress
 * bound: a gate that is still streaming is never plated. The panel reads drawn only when its own content reads drawn
 * (`readPanelContent`), and the document reports drawn once every panel has (`ISLAND_DRAWN_SETTLE_MS`).
 *
 * It never stops watching: after the drawn report, a display that marks itself busy again or an image that starts
 * loading posts `island-busy` (the card makes Allow unavailable until the next drawn report), and a failed item posts
 * `island-failed` (the card shows its "could not be shown" state, with Try again; nothing is reported after it).
 */
export function IslandPanelMountedSignal({ children }: { children?: ReactNode } = {}): ReactElement {
  const id = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    postProgress("panel-mounted");
    const root = rootRef.current;
    if (!root) return;
    const media = new Map<Element, MediaReading>();
    let live = true;
    const check = () => {
      if (!live) return;
      watchMedia(root, media, check);
      drawnState.panels.set(id, readPanelContent(root, media));
      reportDocument();
    };
    const observer =
      typeof MutationObserver === "function"
        ? new MutationObserver((records) => {
            let content = false;
            for (const record of records) {
              if (record.type === "attributes" && record.attributeName === "src") media.delete(record.target as Element);
              if (record.type === "childList" || record.type === "characterData") content = true;
            }
            if (content) contentChanged();
            check();
          })
        : null;
    observer?.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-busy", "role", "class", "src", "data-review-target-floor", "data-dynamic-renderer-floor", "data-render-failure-class"],
    });
    check();
    return () => {
      live = false;
      observer?.disconnect();
      drawnState.panels.delete(id);
    };
  }, [id]);
  return (
    <div ref={rootRef} style={{ display: "contents" }} data-island-panel="">
      {children}
    </div>
  );
}
