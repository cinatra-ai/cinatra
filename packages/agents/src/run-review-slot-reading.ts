// ---------------------------------------------------------------------------
// WHAT THE RUN'S REVIEW SLOT SAYS THE REVIEW STEP SHOULD DRAW (cinatra#2970).
//
// Plan (A) §4.2, the maintainer's own words for the review screen's slot: the
// run card "should basically just be a card (maybe even an empty review screen)
// with a spinning icon which is a temporary placeholder for the review screen.
// Once the agent is done and the output generated, that … card is being
// automatically replaced with the 'Review requested' screen."
//
// `readRunReviewSlot` (cinatra#2997) is the one reader of that question, and it
// answers with two facts about the run's own rows: the id of its most recent
// review gate, pending or resolved, and whether the run has produced something
// whose review question is not answered yet. THIS is the pure step from those
// two facts to the three readings, so the setup run page's review step and the
// run page's own panel draw the same reading of the same run rather than each
// interpreting the slot for itself.
//
// A LEAF ON PURPOSE. It imports nothing, so the suite that pins the table runs
// it rather than a copy of it, and the server screen can call it — a
// non-component export of a `"use client"` module reaches the server graph as a
// client reference and calling one is not calling the function
// (`instance-screens-client-boundary.test.ts`).
// ---------------------------------------------------------------------------

/** The run's review slot as `readRunReviewSlot` answers it. */
export type RunReviewSlot = {
  /** The run's most recent review gate — pending OR resolved — or none. */
  reviewTaskId: string | null;
  /** The run produced something whose review question is still unanswered. */
  awaiting: boolean;
};

/**
 * The three readings the review step can have.
 *
 * - `none`    — this run has no review to show, now or later. Nothing is drawn
 *   for the step, so its row is closed and muted rather than opening an empty
 *   column (cinatra#2970).
 * - `working` — the run produced something and its review question is still
 *   open: the placeholder, which is the review screen's own frame, empty.
 * - `review`  — there is a gate to address: the review card itself, which draws
 *   the pending screen or the settled reading from its own state ladder.
 */
export type RunReviewStepReading = "none" | "working" | "review";

/**
 * THE GATE WINS OVER THE OUTBOX, which is the same order the run page's panel
 * reads them in. A run that owes a SECOND review carries both at once — its
 * first gate on file, another artifact's outbox row still pending — and the
 * reader who decided the first one must keep seeing what they decided until the
 * next gate actually exists. Answering `working` there would replace the
 * reader's own decision with a spinner.
 *
 * AND BOTH EMPTY IS A REAL ANSWER, not a missing one: this run has produced
 * nothing reviewable, so there is no review screen for a placeholder to be a
 * placeholder FOR. The plan draws no "no review yet" screen and none is invented
 * here — the step is simply one the run has nothing to show for.
 */
export function runReviewStepReading(
  slot: RunReviewSlot | null | undefined,
): RunReviewStepReading {
  if (!slot) return "none";
  if (slot.reviewTaskId) return "review";
  return slot.awaiting ? "working" : "none";
}
