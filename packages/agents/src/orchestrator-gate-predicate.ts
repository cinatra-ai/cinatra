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
 * cinatra#3562: a stored policy's `steps` as a list of step objects, or null
 * when the list cannot be read: `steps` is no list (absent, or a policy saved
 * as `{}`), or an entry is no object. An unreadable list is never read as a
 * flow with no renderer step: the caller cannot tell which step a pause is,
 * and so must not show or refresh one.
 */
export function rendererGateStepsOf(steps: unknown): Array<RendererGateStepShape & { gateCount?: unknown }> | null {
  if (!Array.isArray(steps)) return null;
  const isStep = (step: unknown): step is RendererGateStepShape & { gateCount?: unknown } =>
    step !== null && typeof step === "object" && !Array.isArray(step);
  return steps.every(isStep) ? steps : null;
}

/**
 * cinatra#3562: the largest `gateCount` a step can carry for the walk below. A
 * step's `gateCount` is the number of pauses that one compiled step produces:
 * 1 for an input step, and a split child gate is its own step of 1. The
 * compiler copies the value as authored and nothing else bounds it, so a step
 * that claims more than this many pauses gives no place.
 */
export const RENDERER_GATE_STEP_GATE_COUNT_LIMIT = 64;

/**
 * cinatra#3562: the number of places a run's renderer gate list can hold, the
 * same limit as `RENDERER_GATE_PLACE_LIMIT` in packages/a2a (event-log.ts): a
 * place at or past it is never written. A real flow has a few person steps.
 */
export const RENDERER_GATE_INDEX_LIMIT = 1024;

/**
 * cinatra#3562: the place of a renderer gate in the run's renderer gate
 * sequence, read from the compiled steps alone (no expiry): the gate index at
 * which the one renderer step whose `xRenderer` is `xRenderer` starts. It walks
 * the steps as the live resolver does (`resolveWayflowXRenderer` in
 * execution.ts: `stepFiresRendererGate`, `gateCount` 1 when not a number).
 *
 * Null when no renderer step, or more than one, carries that renderer, or when
 * that step spans more than one gate: the place is then not one index. Null
 * also when any renderer step has a numeric `gateCount` that is not a whole
 * number from 1 to `RENDERER_GATE_STEP_GATE_COUNT_LIMIT`, or when the place is
 * not below `RENDERER_GATE_INDEX_LIMIT`: the stored policy can be replaced as a
 * whole, so its values are not trusted to size anything.
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
    if (!Number.isInteger(gateCount) || gateCount < 1 || gateCount > RENDERER_GATE_STEP_GATE_COUNT_LIMIT) return null;
    if (step.xRenderer === xRenderer) {
      if (found !== null || gateCount !== 1) return null;
      if (accumulated >= RENDERER_GATE_INDEX_LIMIT) return null;
      found = accumulated;
    }
    accumulated += gateCount;
  }
  return found;
}
