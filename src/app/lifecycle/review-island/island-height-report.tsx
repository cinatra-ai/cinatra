"use client";

// THE ISLAND REPORTS ITS OWN CONTENT HEIGHT (cinatra#3047).
//
// WHY IT HAS TO BE THE DOCUMENT THAT SAYS SO. The card that frames this island
// gave the frame a FIXED expanded height. A reviewed target is usually shorter
// than that ceiling, so expanding could only ever add empty ground beneath the
// reading and push the frame's own control past the fold — and a reader who
// scrolled to that control was then looking at the ground, with the target's
// header, chip and revision line scrolled out above. The frame was never blank;
// there was simply nothing in the part of it a reader could see.
//
// The host cannot measure this itself. The island is same-origin on the
// first-party surfaces but CROSS-ORIGIN inside a third-party frame, where
// reading `contentDocument` throws — so the one place the content's height is
// knowable everywhere is inside the document, and it says so by message.
//
// IT CARRIES NOTHING BUT A NUMBER. The message is a height and a marker, posted
// to the parent and to nobody else; the host takes it only from the window it
// framed and clamps it into the range the drawing fixes, so a wrong or hostile
// number can at worst pick a height between the two the card already draws.

import { useEffect } from "react";

/** The marker the host matches on. Mirrored by the card that reads it. */
export const REVIEW_ISLAND_HEIGHT_MESSAGE = "cinatra:review-island-height";

/**
 * The island root the measurement is taken from.
 *
 * BOTH ROOTS, and that is the point. The body is the reading; the empty island
 * is what EVERY denial and every absence draws — one painted rectangle with
 * nothing in it. A denial that reported nothing would leave the frame with no
 * height to size from, and the host's no-report rule (keep the control, keep
 * the ceiling) would then draw the very thing this closes: an expanded frame of
 * empty ground with only its own control in it. So the denial reports too, and
 * what it reports fits the collapsed box, so the frame stays that box and is
 * offered no Expand at all.
 *
 * It says nothing about WHICH refusal it is: every denial is the same element
 * and reports the same number, and that number lands in the same "fits its box"
 * band any short reading lands in.
 */
const ISLAND_ROOT_SELECTOR =
  '[data-conformance-id="review-target-island-body"], [data-conformance-id="review-target-island-empty"]';

/**
 * Measure the CONTENT, never the box.
 *
 * The island body carries `min-h-dvh` so its own ground paints the whole frame,
 * which means its `scrollHeight` is at least the frame's height and can never
 * report a document SHORTER than the frame it sits in — the one thing this
 * measurement exists to detect. So the height is taken from where the content
 * actually ends: the lowest bottom edge among the body's children, plus the
 * body's own bottom padding.
 */
function measureContentHeight(body: Element): number {
  const top = body.getBoundingClientRect().top;
  let bottom = top;
  for (const child of Array.from(body.children)) {
    const rect = child.getBoundingClientRect();
    // A zero-height child (the document-ground style tag) moves nothing.
    if (rect.height > 0) bottom = Math.max(bottom, rect.bottom);
  }
  const paddingBottom = Number.parseFloat(getComputedStyle(body).paddingBottom);
  const height = Math.ceil(bottom - top + (Number.isFinite(paddingBottom) ? paddingBottom : 0));
  // A root with nothing in it — the empty island every denial draws — measures
  // zero. It still has to SAY so, because a height of zero is the host's "no
  // report", so it reports the smallest height there is: one that fits the
  // collapsed box, which is what a rectangle with nothing in it needs.
  return Math.max(1, height);
}

/**
 * Report the island's content height to the frame around it, and keep reporting
 * it while the content changes size (a renderer that loads late, an image that
 * settles, a reflow at a new width).
 *
 * Renders nothing. Outside a frame it does nothing at all: `window.parent` is
 * `window` at the top level, and a document that is its own parent has no host
 * to tell.
 */
export function ReviewIslandHeightReport(): null {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.parent === window) return;
    const body = document.querySelector(ISLAND_ROOT_SELECTOR);
    if (!body) return;

    let last = -1;
    const report = () => {
      const height = measureContentHeight(body);
      if (height <= 0 || height === last) return;
      last = height;
      // The parent's origin is not knowable from inside a third-party frame, and
      // the payload is a layout number with nothing in it to protect. The host
      // takes it only from the window it framed itself.
      window.parent.postMessage({ marker: REVIEW_ISLAND_HEIGHT_MESSAGE, height }, "*");
    };

    report();
    const observer = new ResizeObserver(report);
    observer.observe(body);
    for (const child of Array.from(body.children)) observer.observe(child);
    return () => observer.disconnect();
  }, []);

  return null;
}
