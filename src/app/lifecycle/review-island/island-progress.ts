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
  const attempt = Number(raw);
  return Number.isInteger(attempt) && attempt >= 0 ? attempt : null;
}

/** Compose one message. Built here, in one place, so nothing can grow a field. */
export function reviewIslandProgressMessage(
  type: ReviewIslandProgressType,
  attempt: number,
): ReviewIslandProgressMessage {
  return { channel: REVIEW_ISLAND_PROGRESS_CHANNEL, type, attempt };
}
