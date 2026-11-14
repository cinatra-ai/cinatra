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

import { useEffect, useRef } from "react";
import type { ReactElement } from "react";

import { islandContentHeight, reviewIslandHeightMessage, parseReviewIslandFrameName, reviewIslandProgressMessage, type ReviewIslandProgressType } from "./island-height-report";
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

/**
 * "The island document is answering." Posted BEFORE any panel work — it is the
 * first child of the body — so the card can cancel its initial-response bound
 * and start watching for progress instead.
 */
export function IslandReadySignal(): null {
  useEffect(() => {
    postProgress("island-ready");
  }, []);
  return null;
}

/** "A panel arrived." Posted as each target's panel mounts, which restarts the
 *  card's idle-progress bound: a gate that is still streaming is never plated. */
export function IslandPanelMountedSignal(): null {
  useEffect(() => {
    postProgress("panel-mounted");
  }, []);
  return null;
}
