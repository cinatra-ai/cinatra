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
 * THE LINE IS DRAWN IN EVERY READING, AND THE EMPTY READING HAS A WORD FOR IT
 * (cinatra#3174 fix leg 3, after the second graded proof round).
 *
 * Section VI draws "Estimated run duration" beneath the rows in ALL FIVE of its
 * pictures, and the second round measured the line in NONE of its eight frames:
 * on a freshly installed agent the history tier has nothing to answer with, and
 * the card answered a missing estimate by drawing no line at all. A line the
 * drawing draws in every picture may not disappear because the estimator had
 * nothing to say.
 *
 * WHERE THE WORD COMES FROM, said plainly because it is not the drawing's. The
 * ratified drawing gives exactly one value anywhere — "About 45s - 3.4 hr." —
 * and no wording for a reading with no estimate; neither does Components'
 * "Standard scheduling step", which section VI reproduces. So the empty
 * reading's word is the one this leg's task names, and it is kept HERE rather
 * than in a renderer so the two surfaces cannot come to two spellings of it.
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

/**
 * WHAT THE LINE READS WHERE THERE IS NO ESTIMATE.
 *
 * Not a sentence the drawing draws — see the note above — and deliberately not
 * an invented duration either: a made-up band over a template with no history
 * would be a worse answer than saying there is none.
 */
export const DURATION_LINE_NO_ESTIMATE = "Unavailable.";

/** The line's value: the estimate's own sentence, or the empty reading's word. */
export function durationLineValue(copy: string | null | undefined): string {
  return copy ?? DURATION_LINE_NO_ESTIMATE;
}

/** The drawing's own sentence, over the estimate's own bands. */
export function durationCopyFor(d: DurationBands): string {
  const min = formatRange(d.prepMinSeconds + d.gatedMinSeconds);
  const max = formatRange(d.prepMaxSeconds + d.gatedMaxSeconds);
  return `About ${min} – ${max}.`;
}
