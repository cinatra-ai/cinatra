// THE ISLAND REPORTS ITS OWN HEIGHT (the twelfth proof round's counted defect on
// cinatra#3143, 2026-09-10).
//
// WHAT WAS WRONG. The card framed the island at ONE FIXED HEIGHT — a constant
// per pinned target — and a constant fits neither column: on the review route
// the island drew about 508 px of empty panel below the last target's body, and
// on the run route the sixth target's body was clipped mid-sentence at the
// frame's bottom edge. `specs/app-artifact-review.html` §IV gives every target
// "the single region into which the artifact's type renderer mounts"; half a
// panel of nothing and a body cut in two are the same sentence broken from
// opposite sides.
//
// WHAT CROSSES. One number, from this document to the frame that holds it, and
// nothing else. It is not content, not a selector, not a credential and not a
// callback: the island stays display-only, and the host stays the only thing
// that can act. The message is named, its shape is checked on arrival, and the
// host additionally requires that it came from the window of the frame it is
// sizing — a page that shouts this number at the card from anywhere else moves
// nothing.
//
// WHY THE MEASUREMENT WALKS THE CONTENT. The island body carries `min-h-dvh`
// (see `island-color-scheme.ts`) so the document's own unthemed ground never
// paints around the panel — which pins `document.documentElement.scrollHeight`
// to AT LEAST the height of the frame the host is currently giving it. A
// reporter that read that would answer the host with the host's own number, and
// a frame that had once been too tall could never come back down. So the
// measurement walks the island body's CHILDREN — the work — and adds the
// padding beneath them. It reads no palette and no class: the same content
// answers the same number in light and in dark.

/** The message type the island names its rendered height with. The client half
 *  of this literal lives beside the card that listens for it, and the two are
 *  pinned to each other by the card's own suite and by this module's. */
export const REVIEW_ISLAND_HEIGHT_MESSAGE_TYPE = "cinatra.review-island.height";

/** The one message the island posts out of the frame. */
export type ReviewIslandHeightMessage = {
  type: typeof REVIEW_ISLAND_HEIGHT_MESSAGE_TYPE;
  height: number;
};

/** The message for a measured height, rounded UP: a fractional layout that lost
 *  its last sub-pixel to a floor would clip the final row of text. */
export function reviewIslandHeightMessage(height: number): ReviewIslandHeightMessage {
  return { type: REVIEW_ISLAND_HEIGHT_MESSAGE_TYPE, height: Math.ceil(height) };
}

/**
 * The height a message names, or `null` for "this is not that message".
 *
 * Deliberately total and deliberately narrow: a foreign type, a missing or
 * non-numeric height, a NaN, a zero and a negative are one answer, so nothing a
 * sender writes can reach the frame's style beyond a positive finite number.
 */
export function parseReviewIslandHeight(raw: unknown): number | null {
  if (typeof raw !== "object" || raw === null) return null;
  const message = raw as { type?: unknown; height?: unknown };
  if (message.type !== REVIEW_ISLAND_HEIGHT_MESSAGE_TYPE) return null;
  const height = message.height;
  if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) return null;
  return Math.ceil(height);
}

/**
 * The rendered height of the island's WORK, measured from the container the
 * panels are drawn in.
 *
 * The walk is the point (see the module header): the container's own box is
 * `min-h-dvh` and therefore reports the frame's height, while its children
 * report the work's. Everything the document puts above the container — a body
 * margin, anything the layout leaves before it — is measured too rather than
 * assumed to be zero, so the number is a height for the FRAME and not merely a
 * height for the container.
 *
 * `exclude` is the reporter's own hidden marker: it is inside the container and
 * is not work.
 */
export function islandContentHeight(container: Element, exclude?: Element | null): number {
  const view = container.ownerDocument?.defaultView ?? null;
  if (!view) return 0;
  const box = container.getBoundingClientRect();
  const style = view.getComputedStyle(container);
  const padTop = Number.parseFloat(style.paddingTop) || 0;
  const padBottom = Number.parseFloat(style.paddingBottom) || 0;
  const above = box.top + (view.scrollY || 0);

  // An empty island is its own padding — never zero, so a document that has
  // nothing to draw still reports a box rather than collapsing the frame.
  let content = padTop;
  for (const child of Array.from(container.children)) {
    if (child === exclude) continue;
    const rect = child.getBoundingClientRect();
    // A child the layout gave no box — the ground stylesheet, anything
    // `display:none` — is not part of the work's height.
    if (rect.width === 0 && rect.height === 0) continue;
    content = Math.max(content, rect.bottom - box.top);
  }
  return Math.ceil(above + content + padBottom);
}
