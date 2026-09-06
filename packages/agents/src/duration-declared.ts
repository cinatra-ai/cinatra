// ---------------------------------------------------------------------------
// THE ESTIMATED RUN DURATION LINE, FOR A RUN WITH NO HISTORY (cinatra#3224).
//
// The ratified drawing, components reference, the standard scheduling step:
// "An Estimated run duration line sits above the actions" — as part of the
// step's own anatomy, with no condition on it — and the reading a run returns
// to once a schedule is set shows "the same Estimated run duration". Its drawn
// examples carry the line populated, "About 45s – 3.4 hr.", in every reading.
//
// The estimator answers `null` for a freshly installed agent: no completed-run
// history to aggregate, and no analysis where there is nothing to analyse. The
// form used to draw NO line for that case, and before that the literal
// "Unavailable." — neither is a reading the drawing gives. THE ELECTED ANSWER:
// the line is always drawn, and where the estimator has nothing it reads the
// drawing's own populated shape over a stated range derived from the agent's
// declared step count, never a sentence saying it has no answer.
//
// THE STATED BAND, per declared step: one minute to ten minutes. A run is at
// least one step, so a declaration that counts none, or a count the surface
// cannot read, is read as one step — "About 1 min – 10 min.", the pinned text
// for a fresh one-step agent. The band is a stated assumption, carried in the
// estimate's own `notes` so a reader of the record never mistakes it for a
// measured value; the moment the agent has history, the estimator's own
// reading takes the line back.
// ---------------------------------------------------------------------------

import type { DurationEstimate } from "./trigger-duration-estimate";

/** The stated lower bound per declared step, in seconds. */
export const DECLARED_STEP_MIN_SECONDS = 60;
/** The stated upper bound per declared step, in seconds. */
export const DECLARED_STEP_MAX_SECONDS = 600;

/** The step count the line is read over: at least one, whatever was declared. */
export function declaredStepCountForEstimate(declaredStepCount: number | null | undefined): number {
  return typeof declaredStepCount === "number" && Number.isFinite(declaredStepCount) && declaredStepCount >= 1
    ? Math.floor(declaredStepCount)
    : 1;
}

/**
 * The estimate the line draws where the estimator has none: the declared step
 * count over the stated band. Shaped like every other estimate so the one
 * renderer (`durationCopy`) draws it.
 */
export function declaredDurationEstimate(declaredStepCount: number | null | undefined): DurationEstimate {
  const steps = declaredStepCountForEstimate(declaredStepCount);
  return {
    source: "declared",
    prepMinSeconds: steps * DECLARED_STEP_MIN_SECONDS,
    prepMaxSeconds: steps * DECLARED_STEP_MAX_SECONDS,
    gatedMinSeconds: 0,
    gatedMaxSeconds: 0,
    confidence: "low",
    notes: `Derived from ${steps} declared step${steps === 1 ? "" : "s"} at ${DECLARED_STEP_MIN_SECONDS}s–${DECLARED_STEP_MAX_SECONDS}s each; no completed-run history.`,
    computedAt: new Date(0).toISOString(),
  };
}
