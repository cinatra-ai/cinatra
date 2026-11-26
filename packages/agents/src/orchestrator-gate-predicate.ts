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

// cinatra#3089: a step that names its gate's node (`artifactReviewGateNode`,
// the compiled step of an embedded marked gate) is the step of a pause by the
// pause's VERIFIED node only, never by its position. `reviewGateNodeSteps`
// reads those steps from a stored policy (any other shape is no such step).
// `stepForVerifiedPause` answers which step a pause with a verified node is:
//   * "matched": the node-named step whose node is the verified node; the pause
//     takes all of that step (renderer, schema, step number, keys, marker);
//   * "mispicked": the step the position picked names another node; the pause
//     takes nothing of it and is drawn with what it carries itself;
//   * "positional": neither; the position's pick stands (a step that names no
//     node keeps today's reading; general placement by node is cinatra#4772).
export type ReviewGateNodeStep = {
  node: string;
  targetsInput: string;
  stepNumber: number | null;
  step: Record<string, unknown>;
};
export const ARTIFACT_REVIEW_GATE_UNVERIFIED = "ARTIFACT_REVIEW_GATE_UNVERIFIED";
export const ARTIFACT_REVIEW_GATE_UNVERIFIED_TEXT =
  `${ARTIFACT_REVIEW_GATE_UNVERIFIED}: this flow reviews artifacts at a named step, and the pause carries no verified step claim, ` +
  "so it cannot be told whether this pause is that review; the pause was not offered as an approval and the run was stopped";
export const PAUSE_POLICY_UNREAD = "PAUSE_POLICY_UNREAD";
export const PAUSE_POLICY_UNREAD_TEXT =
  `${PAUSE_POLICY_UNREAD}: the steps of this flow could not be read for this pause in any of its read attempts, so it cannot be ` +
  "told whether this pause is an artifact review; the pause was not offered as an approval and the run was stopped";
/** cinatra#3089: the waits between the attempts of a pause's template read. Nothing re-drives a pause report the
 *  handler drops (the dispatch's blocking send returns it once), so a fault is retried here, briefly, before a stop. */
export const PAUSE_POLICY_READ_WAITS_MS: readonly number[] = [250, 1000];
/** Reads with the waits above between attempts. `ok: false` when every attempt threw; a value (also `null`) is returned. */
export async function readPausePolicyWithRetry<T>(
  read: () => Promise<T>,
  label: string,
  waitsMs: readonly number[] = PAUSE_POLICY_READ_WAITS_MS,
): Promise<{ ok: true; value: T } | { ok: false }> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return { ok: true, value: await read() };
    } catch (err) {
      console.warn(`[pause-policy] ${label} read attempt ${attempt + 1}/${waitsMs.length + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (attempt >= waitsMs.length) return { ok: false };
      await new Promise((resolve) => setTimeout(resolve, waitsMs[attempt]));
    }
  }
}
export function reviewGateNodeSteps(steps: unknown): ReviewGateNodeStep[] {
  if (!Array.isArray(steps)) return [];
  const found: ReviewGateNodeStep[] = [];
  for (const step of steps) {
    if (step === null || typeof step !== "object" || Array.isArray(step)) continue;
    // The node is read first: a step that names no node is not read further.
    const node = (step as Record<string, unknown>)["artifactReviewGateNode"];
    if (typeof node !== "string" || node.length === 0) continue;
    const { artifactReviewTargetsInput: targetsInput, stepNumber } = step as Record<string, unknown>;
    if (typeof targetsInput !== "string" || targetsInput.length === 0) continue;
    found.push({ node, targetsInput, stepNumber: typeof stepNumber === "number" ? stepNumber : null, step: step as Record<string, unknown> });
  }
  return found;
}
export function stepForVerifiedPause(input: {
  nodeSteps: readonly ReviewGateNodeStep[];
  verifiedNode: string;
  positionalStepNumber: number | null;
}): { kind: "matched"; step: ReviewGateNodeStep } | { kind: "mispicked" } | { kind: "positional" } {
  const own = input.nodeSteps.find((s) => s.node === input.verifiedNode);
  if (own) return { kind: "matched", step: own };
  const picked = input.positionalStepNumber;
  if (picked !== null && input.nodeSteps.some((s) => s.stepNumber === picked)) return { kind: "mispicked" };
  return { kind: "positional" };
}
