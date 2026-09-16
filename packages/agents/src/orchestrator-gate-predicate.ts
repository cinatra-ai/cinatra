// #839: Shared predicate for "does a compiled approvalPolicy step consume a
// runtime renderer-gate slot". A step maps to a live HITL renderer gate IFF it
// declares an `xRenderer` AND is not a metadata-only phantom gate.
//
// A phantom gate is a FlowNode `gateStep` whose wrapped subflow never pauses at
// a non-context runtime HITL gate (the compiler proves this structurally and
// stamps `firesRendererGate: false`). blog-pipeline's four review gateSteps
// ("Blog ideas"/"Blog draft"/"Image prompts"/"LinkedIn post") are such phantoms
// — their subflows only emit context-selector gates, so no reviewer pause ever
// fires. If they were counted, the renderer-gate index (which advances once per
// REAL non-context interrupt) would map the single real reviewer interrupt
// (idea_selection_gate) onto the FIRST phantom childStep (null schema) instead
// of idea_selection_gate's own {selectedIdeaJson} schema.
//
// This predicate MUST be applied identically at every renderer-gate walk so the
// live resolver (execution.ts), the replay submission map (run-actions.ts) and
// the stepper (instance-screens.tsx) stay in lockstep. #824 excludes context
// gates at RUNTIME by payload shape; this excludes phantom gateSteps at COMPILE
// time by the same "only real runtime pauses consume a slot" invariant.
export interface RendererGateStepShape {
  xRenderer?: string;
  firesRendererGate?: boolean;
}

export function stepFiresRendererGate(step: RendererGateStepShape): boolean {
  return typeof step.xRenderer === "string" && step.firesRendererGate !== false;
}

// The same question one step further on: not "does this step consume a gate
// slot" but "which slot of how many is the gate sitting in". It lives here,
// beside the predicate that builds that ladder, because this is the PURE
// ladder module the gated surfaces already reach. Keeping it in
// run-stepper-steps.ts pulled that module onto four locked route graphs for
// one pure helper, which the route-graph ratchet measured as +1 on each.

/**
 * WHERE A REVIEW GATE SITS ON THE RUN'S RAIL — THE ONE READING BOTH SURFACES USE
 * (cinatra#3080, the fix leg after the second proof round).
 *
 * THE DRAWING DRAWS THE LINE. `specs/app-lifecycle-cards.html` §XIII.1 draws the
 * in-run review gate outside a conversation as the word over a mono line —
 * "Review" beside "Outreach agent · run rn_8f31… · step 4 of 6" — pending and
 * settled alike. What the second proof round caught is not the line but a
 * DISAGREEMENT: the run page read "step 2 of 2" and the review page "step 1 of 1"
 * for ONE gate, because each named the gate's place from a different list — the
 * run's work ladder on one side, the ladder plus a row per review on the other.
 *
 * A GATE IS A RAIL ENTRY, NOT A WORK STEP. `app-artifact-review.html` §I.3 draws
 * a run that wrote a post and its featured image as two review entries NUMBERED
 * AFTER the work steps ("Review · the post" 4, "Review · featured image" 5), and
 * the run page's own rail already draws its trailing rows as `ladder + i + 1`. So
 * the gate's place is the RAIL's place, and this is the single projection both
 * surfaces read it from — the same lockstep guarantee `buildRunStepperSteps` gives
 * the step list itself.
 *
 * TOTAL and pure. A rail that draws no review row yet still places THIS review as
 * the row it is about to draw (the review page's own fail-soft reading: one
 * synthetic Review row after the steps), so the two surfaces answer alike even
 * where one of them has nothing on its rail to count.
 */
export function reviewGateStepPosition(input: {
  /** The run's work-step spine — the numerals the rail draws 1..N. */
  ladderLength: number;
  /** The rail's trailing review rows, in the rail's own order. */
  gateRowCount: number;
  /** Which of those rows is THIS gate (0-based), or null when the surface cannot
   * place it — in which case it is the last row, the one the run is at. */
  gateOrdinal: number | null;
}): { index: number; total: number } {
  const ladder = Math.max(Math.floor(input.ladderLength), 0);
  const rows = Math.max(Math.floor(input.gateRowCount), 1);
  const asked = input.gateOrdinal === null ? rows - 1 : Math.floor(input.gateOrdinal);
  const ordinal = Math.min(Math.max(asked, 0), rows - 1);
  return { index: ladder + ordinal + 1, total: ladder + rows };
}
