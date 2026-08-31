/**
 * "Estimated run duration", as the scheduling step words it.
 *
 * A LEAF ON PURPOSE (cinatra#2853, the picture leg). The wording used to live
 * inside the run page's trigger form, so the SAME row on the schedule card in a
 * conversation had no way to reach it — plan (A) §7.2 draws one row, and two
 * copies of its wording are two rows waiting to disagree. The estimator itself
 * stays where it is: this module knows how to SAY a duration and nothing about
 * how to work one out, so a client bundle can import it without pulling a
 * database read behind it.
 */

import type { DurationEstimate } from "./trigger-duration-estimate";

/** One bound, in the coarsest unit that still reads as a duration. */
export function formatDurationBound(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} hr`;
}

/**
 * The row's text: a RANGE where there is an estimate, and the shipped
 * "Unavailable." where there is none.
 *
 * THE FALLBACK IS THE APP'S OWN, NOT AN INVENTION. Plan (A) §7.2 draws the row
 * "with a range" and says nothing about an agent the estimator cannot answer
 * for — no history, and no task text to read. The run page's scheduling step has
 * always drawn "Unavailable." in exactly that case, and drawing the same word in
 * the same row on the card keeps one surface rather than inventing a second
 * sentence for a state the plan does not word. Named as a deviation.
 */
export function durationCopy(estimate: DurationEstimate | null): string {
  if (!estimate) return "Unavailable.";
  const min = formatDurationBound(estimate.prepMinSeconds + estimate.gatedMinSeconds);
  const max = formatDurationBound(estimate.prepMaxSeconds + estimate.gatedMaxSeconds);
  return `${min}–${max}.`;
}
