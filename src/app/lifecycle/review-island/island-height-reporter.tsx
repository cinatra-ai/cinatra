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

import { islandContentHeight, reviewIslandHeightMessage } from "./island-height-report";

export function IslandHeightReporter(): ReactElement {
  const marker = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const self = marker.current;
    const container = self?.parentElement ?? null;
    const view = container?.ownerDocument?.defaultView ?? null;
    // Not framed — the island opened directly. There is nobody to tell.
    if (!container || !view || view.parent === view) return;

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
