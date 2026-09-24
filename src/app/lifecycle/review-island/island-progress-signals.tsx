"use client";

// ---------------------------------------------------------------------------
// THE ISLAND'S TWO SIGNALS (cinatra#3334). See `island-progress.ts` for what
// they are and why they carry nothing.
//
// They are the ONLY client components in this document, they render nothing,
// and they read nothing: no props from the surface model, no gate ref, no
// target. Each one posts once, on mount — which is exactly the event the card
// is waiting to hear about.
// ---------------------------------------------------------------------------

import { useEffect } from "react";

import {
  parseReviewIslandFrameName,
  reviewIslandProgressMessage,
  type ReviewIslandProgressType,
} from "./island-progress";

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
