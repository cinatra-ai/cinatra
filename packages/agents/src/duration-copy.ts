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
 * THE DRAWING GIVES NO EMPTY READING, so this function is never called for one:
 * a missing estimate draws NO LINE at all. Its callers hold that rule; there is
 * deliberately no "unavailable" wording anywhere in this file, because the
 * drawing has none to copy.
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
