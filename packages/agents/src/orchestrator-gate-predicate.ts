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
 * WHERE THE GATED STEP SITS, for the review gate header's naming line
 * (cinatra#3080, fix leg 7, corrected at convergence).
 *
 * The header draws "step 4 of 6" from the ladder the rail already draws. The
 * live interrupt names the step while the run is parked on it — and names
 * NOTHING once the run has resumed and completed, which is the reading a
 * reviewer arrives at most often. So a run with no live interrupt falls back to
 * the step the rail is showing, bounded by the ladder's own length (a completed
 * run's rail points one past the end). A run with no ladder names no step at
 * all rather than inventing one.
 */
export function gateNamingStep(input: {
  /** How many steps the rail draws. */
  ladderLength: number;
  /** The live interrupt's step as a display index, or null when there is none. */
  currentDisplayIndex: number | null;
  /** The step the rail is showing right now. */
  activeStep: number;
}): { index: number; total: number } | null {
  if (input.ladderLength <= 0) return null;
  const index =
    input.currentDisplayIndex !== null
      ? input.currentDisplayIndex
      : Math.min(input.activeStep, input.ladderLength);
  return { index, total: input.ladderLength };
}
