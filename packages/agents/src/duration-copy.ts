/**
 * THE ESTIMATED-DURATION LINE, RENDERED ONCE (cinatra#3182 item 5, moved into
 * its own leaf by cinatra#3174 fix leg 1).
 *
 * Application Design — Components, "Standard scheduling step": the line is
 * drawn once, populated — "Estimated run duration" over "About 45s – 3.4 hr."
 * Two surfaces draw it now: the run page's scheduling step, which had this
 * function inside it, and the schedule card in a conversation, whose producer
 * is a server module that cannot import a client component. So the renderer
 * moves here — a pure leaf importing nothing — rather than being written twice
 * with two roundings.
 *
 * WHAT THIS LEAF IS, AND IS NOT (cinatra#3174 fix leg 4). It is the SENTENCE
 * both surfaces draw, and only that. The word a reading with NO estimate draws
 * is not shared — the scheduling step draws its line only where there IS a
 * duration to draw, and only the schedule card draws the line in EVERY reading
 * — so that word lives beside the paragraph that draws it, as
 * `DURATION_LINE_NO_ESTIMATE` in `schedule-proposal-card`. One drawer, one
 * home; and the card keeps off a cross-module edge the conversation route's
 * reachable graph does not need to carry.
 */

/** The seconds bands the two tiers of the estimator both produce. */
export type DurationBands = {
  prepMinSeconds: number;
  prepMaxSeconds: number;
  gatedMinSeconds: number;
  gatedMaxSeconds: number;
};

function formatRange(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} hr`;
}

/** The drawing's own sentence, over the estimate's own bands. */
export function durationCopyFor(d: DurationBands): string {
  const min = formatRange(d.prepMinSeconds + d.gatedMinSeconds);
  const max = formatRange(d.prepMaxSeconds + d.gatedMaxSeconds);
  return `About ${min} – ${max}.`;
}
