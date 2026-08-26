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

/**
 * IS THIS STEP'S GATE ALREADY ANSWERED? (cinatra#2975.)
 *
 * The ratified run-surface drawing: "A resolved gate stays on the rail as
 * read-only history — its entry keeps its place and records how it was settled."
 * Plan (A) §4.2 says it of a review in particular: a decided one is kept "on the
 * run's audit trail and on the rail as read-only history".
 *
 * The reading above answers WHAT the step draws; this answers HOW ITS ROW READS,
 * and the two are deliberately separate. The surface of a decided gate is the
 * same review card, drawing its own settled state from its own ladder; the
 * rail's completed circle is a fact about the gate's ROW.
 *
 * `gateStatus` is that row's own status — `pending` while the gate is open,
 * `resolved` once a terminal decision has been committed to it. It is read here
 * for the same reason the recommendation's rail entry reads its park's status
 * rather than the decision's evidence: the evidence belongs to the card, which
 * is the one authority on the interaction (cinatra#2573), while the row's status
 * is a fact about the RAIL's entry. Any other value — a status nobody wrote, one
 * this reading does not know — is not a decision and is not read as one.
 *
 * ONLY THE GATE THE STEP OPENS. `review` is the one reading that names a gate:
 * the placeholder names none and a run with nothing to review has none at all,
 * so neither can be history. A run that owes a SECOND review reads `review`
 * while its first gate is decided and its next artifact is still waiting — the
 * row draws the gate it OPENS, which is that decided one, and goes back to live
 * when the next gate exists and becomes the run's own.
 */
export function runReviewStepSettled(params: {
  reading: RunReviewStepReading;
  gateStatus: string | null | undefined;
}): boolean {
  if (params.reading !== "review") return false;
  return params.gateStatus === "resolved";
}
