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
 * cinatra#3562: the schema key under which a paused gate's durable record
 * carries the refresh value its list step's binding declared when the pause
 * was recorded (`params.refreshValue`). Only the host writes it: a gate's own
 * schema loses the key before the record is made. A refresh of that pause
 * sends this value, so a later deployment that changes or removes the
 * declaration does not change what the waiting flow receives.
 */
export const LIST_STEP_REFRESH_VALUE_SCHEMA_KEY = "x-cinatra-list-step-refresh-value";

/**
 * cinatra#3562: WHAT A PAUSE IS, recorded with its durable gate record (the
 * gate's schema, beside the refresh value), once, at the first record of the
 * task. `GATE_NODE_SCHEMA_KEY` holds the flow node that paused the run as the
 * runtime signed it and the host verified it; a record without it is the
 * recorded fact that the pause had no verified node. A later report never
 * replaces a recorded node; it may add one where none was recorded. `GATE_PLACE_SCHEMA_KEY` holds
 * the place the pause took in the run's renderer step sequence
 * (`getOrAddWayflowRendererGateIndex`); it is never replaced. A refresh, and
 * the place of the pause after it, read these, never an expiring key.
 */
export const GATE_NODE_SCHEMA_KEY = "x-cinatra-gate-node";
export const GATE_PLACE_SCHEMA_KEY = "x-cinatra-gate-place";

/** The verified node a gate's record holds; null when it holds none (no node, or a recorded "none"). */
export function recordedGateNode(schema: unknown): string | null {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return null;
  const value = (schema as Record<string, unknown>)[GATE_NODE_SCHEMA_KEY];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The place a gate's record holds; null when it holds none. */
export function recordedGatePlace(schema: unknown): number | null {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return null;
  const value = (schema as Record<string, unknown>)[GATE_PLACE_SCHEMA_KEY];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** cinatra#3562: the refresh value a gate's recorded schema carries; undefined when none (or blank). */
export function recordedListStepRefreshValue(schema: unknown): string | undefined {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const value = (schema as Record<string, unknown>)[LIST_STEP_REFRESH_VALUE_SCHEMA_KEY];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * cinatra#3562: a stored policy's `steps` as a list of step objects, or null
 * when the list cannot be read: `steps` is no list (absent, or a policy saved
 * as `{}`), or an entry is no object. An unreadable list is never read as a
 * flow with no renderer step: a refresh of a pause in it is refused.
 */
export function rendererGateStepsOf(steps: unknown): RendererGateStepShape[] | null {
  if (!Array.isArray(steps)) return null;
  const isStep = (step: unknown): step is RendererGateStepShape =>
    step !== null && typeof step === "object" && !Array.isArray(step);
  return steps.every(isStep) ? steps : null;
}
