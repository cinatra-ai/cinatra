// ---------------------------------------------------------------------------
// THE SPACE THE COMPOSER STANDS IN (cinatra#3044, the eighth set's second
// defect).
// ---------------------------------------------------------------------------
// The conversation's composer is drawn at the FOOT of the thread, over the
// bottom of the scrolling stream: the stream fills the column and the composer
// is anchored to its bottom edge, opaque, in front of it. Nothing about that is
// wrong — it is how the drawing composes the two — but it only reads correctly
// while the stream RESERVES the height the composer actually occupies.
//
// It reserved a CONSTANT instead: 96px, the padding the column has carried
// since it was written. A composer is not a constant. It grows with the notice
// row above it — the row that names which card the next message acts on — and
// with a prompt that has wrapped onto a second and third line. When it grows
// past the reservation, the pin that puts the newest content at the bottom of
// the stream puts it UNDER the composer, and a card that has just arrived is
// read through whatever is left above the composer's top edge. The eighth
// graded set measured that as roughly 63 CSS px of an arriving card's height.
//
// THE FIX IS RESERVED SPACE, NEVER A Z-ORDER. Drawing the card OVER the
// composer would trade one unreadable surface for another and would break §I's
// input hierarchy, which puts the chat box in front. So the reservation is
// MEASURED from the composer's own rendered box and the stream reserves exactly
// that — the arriving card then lands fully above the composer's top edge, and
// the pin needs no other help.
//
// THE FLOOR IS THE OLD CONSTANT, and it stays for one reason: a measurement of
// zero is what an unlaid-out box reports (a first paint, a test environment
// that does no layout), and treating that as "reserve nothing" would put the
// whole composer over the stream for exactly as long as the layout takes. A
// measurement is only ever allowed to make the reservation BIGGER.
// ---------------------------------------------------------------------------

/**
 * The reservation the column has always carried — Tailwind's `pb-24`, in the
 * pixels it computes to. It is the FLOOR, never the answer on its own.
 */
export const COMPOSER_RESERVED_SPACE_FLOOR_PX = 96;

/**
 * How much room the stream must leave beneath its last element for the composer
 * that stands in front of it.
 *
 * `measuredHeight` is the composer's own rendered height. Anything that is not
 * a finite, positive number is NO MEASUREMENT — not a measurement of nothing —
 * and answers the floor.
 */
export function composerReservedSpacePx(
  measuredHeight: number | null | undefined,
): number {
  if (typeof measuredHeight !== "number" || !Number.isFinite(measuredHeight)) {
    return COMPOSER_RESERVED_SPACE_FLOOR_PX;
  }
  return Math.max(COMPOSER_RESERVED_SPACE_FLOOR_PX, Math.ceil(measuredHeight));
}
