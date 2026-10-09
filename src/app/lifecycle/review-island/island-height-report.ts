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

// ---------------------------------------------------------------------------
// THE ISLAND'S PROGRESS PROTOCOL (cinatra#3334) — the island's half of the
// review card's two-bound load protocol, and the whole of what this document
// ever says to the surface that frames it.
//
// WHY IT EXISTS. The card cannot see inside this document: it watches the
// frame's `load` event and, past a bound, paints "The preview did not load".
// One bound over the whole load cannot tell a hung frame from a gate whose
// targets are simply still arriving, so a review over several targets was
// declared dead while every one of its panels was on its way. The card now
// watches two bounds — an initial-response bound and an idle-progress bound —
// and this document answers into them: `island-ready` before any panel work,
// `panel-mounted` as each panel mounts.
//
// IT IS DATA-FREE, AND THAT IS THE POINT. A message carries the channel, the
// event name and the ATTEMPT the card stamped on this frame — no gate ref, no
// target id, no credential, nothing read out of the surface model. That is what
// makes it safe to answer an opener whose origin this document is not told: the
// island is framed by a first-party page and, inside the widget, by a
// third-party CMS page, and it is never handed either origin. Nothing in the
// message is worth intercepting, so none of it has to be addressed.
//
// THE ATTEMPT RIDES ON THE FRAME'S NAME, not on the island's address. A frame's
// `name` is readable as `window.name` inside the document it holds, so the card
// can stamp its current attempt without adding a query parameter to an address
// whose contents are deliberately closed (the ref, and the server's credential
// where there is one). A document that was not framed by the card carries no
// such name and says nothing at all.
// ---------------------------------------------------------------------------

/** The channel every progress message names. Mirrored in the card
 *  (`packages/agents/src/review-gate-card.tsx`), the way the island's `ic` and
 *  `scheme` query keys already are across that boundary. */
export const REVIEW_ISLAND_PROGRESS_CHANNEL = "cinatra-review-island-progress";

/** The prefix of the frame name the card stamps its attempt into. */
export const REVIEW_ISLAND_FRAME_NAME_PREFIX = "cinatra-review-island";

/** The two things this document says, and the only two. */
export type ReviewIslandProgressType = "island-ready" | "panel-mounted";

/** One progress message — the closed shape, with nothing else in it. */
export interface ReviewIslandProgressMessage {
  channel: typeof REVIEW_ISLAND_PROGRESS_CHANNEL;
  type: ReviewIslandProgressType;
  attempt: number;
}

/** The frame name the card stamps one attempt with. */
export function reviewIslandFrameName(attempt: number): string {
  return `${REVIEW_ISLAND_FRAME_NAME_PREFIX}:${attempt}`;
}

/**
 * The attempt out of a frame name — or null when this document is not inside
 * the card's frame at all (no name, another page's name, a name whose attempt
 * is not a whole number). A null answer means the document says nothing: it has
 * no attempt to name, and a message that cannot name the current attempt is one
 * the card would refuse anyway.
 */
export function parseReviewIslandFrameName(name: string | null | undefined): number | null {
  if (typeof name !== "string") return null;
  const separator = name.indexOf(":");
  if (separator < 0) return null;
  if (name.slice(0, separator) !== REVIEW_ISLAND_FRAME_NAME_PREFIX) return null;
  const raw = name.slice(separator + 1);
  if (raw.length === 0) return null;
  if (!/^(0|[1-9]\d*)$/.test(raw)) return null;
  const attempt = Number(raw);
  return Number.isSafeInteger(attempt) ? attempt : null;
}

/** Compose one message. Built here, in one place, so nothing can grow a field. */
export function reviewIslandProgressMessage(
  type: ReviewIslandProgressType,
  attempt: number,
): ReviewIslandProgressMessage {
  return { channel: REVIEW_ISLAND_PROGRESS_CHANNEL, type, attempt };
}
