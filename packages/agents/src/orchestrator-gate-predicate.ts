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

/**
 * cinatra#3562: the place of a renderer gate in the run's renderer gate
 * sequence, read from the compiled steps alone (no expiry): the gate index at
 * which the one renderer step whose `xRenderer` is `xRenderer` starts. It walks
 * the steps as the live resolver does (`resolveWayflowXRenderer` in
 * execution.ts: `stepFiresRendererGate`, `gateCount` 1 when not a number).
 *
 * Null when no renderer step, or more than one, carries that renderer, or when
 * that step spans more than one gate: the place is then not one index.
 */
export function rendererGateIndexOfRenderer(
  steps: ReadonlyArray<RendererGateStepShape & { gateCount?: unknown }>,
  xRenderer: string,
): number | null {
  let accumulated = 0;
  let found: number | null = null;
  for (const step of steps) {
    if (!stepFiresRendererGate(step)) continue;
    const gateCount = typeof step.gateCount === "number" ? step.gateCount : 1;
    if (step.xRenderer === xRenderer) {
      if (found !== null || gateCount !== 1) return null;
      found = accumulated;
    }
    accumulated += gateCount;
  }
  return found;
}
