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

// THE DRAWN COUNT (cinatra#3089): the panels this document was given and the
// ones that have mounted. One document holds one island, so module state is
// that document's; a Set keyed by each signal's own id counts a panel once even
// when its effect runs twice.
const drawnState: { expected: number | null; mounted: Set<string>; posted: boolean } = {
  expected: null,
  mounted: new Set(),
  posted: false,
};

function postDrawnWhenComplete(): void {
  const { expected, mounted, posted } = drawnState;
  if (posted || expected === null || mounted.size < expected) return;
  if (typeof window === "undefined") return;
  const attempt = parseReviewIslandFrameName(window.name);
  if (attempt === null) return;
  drawnState.posted = true;
  // `*` for the reason given in `postProgress`: the card checks provenance.
  window.parent.postMessage(reviewIslandDrawnMessage(attempt, expected), "*");
}

/**
 * "The island document is answering." Posted BEFORE any panel work — it is the
 * first child of the body — so the card can cancel its initial-response bound
 * and start watching for progress instead.
 *
 * `panels` (cinatra#3089) is how many panels this document draws: once that many
 * have mounted it posts `island-drawn` with the count (0 at once, for the one
 * empty document). Omitted, nothing is reported as drawn.
 */
export function IslandReadySignal({ panels }: { panels?: number } = {}): null {
  useEffect(() => {
    if (panels === undefined) {
      postProgress("island-ready");
      return;
    }
    if (panels > 0) postProgress("island-ready");
    drawnState.expected = panels;
    postDrawnWhenComplete();
  }, [panels]);
  return null;
}

/** Posts `island-failed` once per document (cinatra#3089); no drawn report follows it. */
function postFailedOnce(): void {
  if (drawnState.posted) return;
  drawnState.posted = true;
  postProgress("island-failed");
}

/** The marks a display leaves when it fell to its floor instead of drawing the item: the review mount's floor, the
 *  runtime loader's floor and the build-map slot's degraded notice. */
const PANEL_FLOOR_SELECTOR = "[data-review-target-floor],[data-dynamic-renderer-floor],[data-render-failure-class]";

type MediaReading = "loading" | "loaded" | "failed";

/**
 * WHAT ONE PANEL'S OWN CONTENT READS (cinatra#3089): drawn only once every item of it has finished loading
 * successfully. One rule for every kind the panel can hold:
 *   - a display that fell to its floor: failed (the item itself is not on screen);
 *   - a display still loading (the runtime loader's skeleton, or anything marked `aria-busy="true"`): loading;
 *   - an image (an image representation's preview, a pinned capture, an image a display draws): its own decode
 *     promise answers, `img.decode()`, which settles once the bytes loaded and decoded, and rejects on a failed
 *     request; a failed image is failed;
 *   - a video: loaded at `readyState >= HAVE_CURRENT_DATA`, failed when it carries an `error`;
 *   - text, a structured-data view, a table: drawn once mounted (React committed it before this effect runs).
 * `media` holds each image's and video's settled reading.
 */
function readPanelContent(root: Element, media: WeakMap<Element, MediaReading>): "loading" | "drawn" | "failed" {
  if (root.querySelector(PANEL_FLOOR_SELECTOR)) return "failed";
  let loading = root.querySelector('[aria-busy="true"]') !== null;
  for (const element of root.querySelectorAll("img, video")) {
    const reading = media.get(element) ?? "loading";
    if (reading === "failed") return "failed";
    if (reading === "loading") loading = true;
  }
  return loading ? "loading" : "drawn";
}

/** Start reading each image and video under `root` once, recording its settled reading in `media`; `changed` runs
 *  whenever one settles. */
function watchMedia(root: Element, media: WeakMap<Element, MediaReading>, changed: () => void): void {
  for (const element of root.querySelectorAll("img, video")) {
    if (media.has(element)) continue;
    media.set(element, "loading");
    const settle = (reading: MediaReading) => {
      if (media.get(element) !== "loading") return;
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
 * bound: a gate that is still streaming is never plated. The panel counts as drawn only when its own content reads
 * drawn (`readPanelContent`): a display still loading, or an image or capture still on its way, holds the drawn report
 * back, and the card's bound still runs. A failed item posts `island-failed` and no drawn report ever follows on this
 * document: the card shows its "could not be shown" state, with Try again.
 */
export function IslandPanelMountedSignal({ children }: { children?: ReactNode } = {}): ReactElement {
  const id = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    postProgress("panel-mounted");
    const root = rootRef.current;
    if (!root) return;
    const media = new WeakMap<Element, MediaReading>();
    let done = false;
    const check = () => {
      if (done) return;
      watchMedia(root, media, check);
      const reading = readPanelContent(root, media);
      if (reading === "loading") return;
      done = true;
      observer?.disconnect();
      if (reading === "failed") {
        postFailedOnce();
        return;
      }
      drawnState.mounted.add(id);
      postDrawnWhenComplete();
    };
    // A display that mounts later (the runtime loader's import) or swaps an image in is read again.
    const observer = typeof MutationObserver === "function"
      ? new MutationObserver(check)
      : null;
    observer?.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-busy", "src"] });
    check();
    return () => {
      done = true;
      observer?.disconnect();
    };
  }, [id]);
  return (
    <div ref={rootRef} style={{ display: "contents" }} data-island-panel="">
      {children}
    </div>
  );
}
