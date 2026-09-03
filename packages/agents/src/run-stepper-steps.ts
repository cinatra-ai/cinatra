// ---------------------------------------------------------------------------
// Shared run → stepper-steps projection (cinatra#2063, owner ruling 2026-07-25).
//
// ONE source of truth for turning an agent template's approval policy into the
// sequential display steps the vertical run stepper renders. Consumed by BOTH
// the run-detail panel (instance-screens.tsx) and the agent-run REVIEW surface
// (`/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]`), so the
// run's step list is IDENTICAL on both surfaces — a divergence would shift every
// prompt→step mapping by a slot (the same lockstep guarantee the live resolver in
// execution.ts and the replay map in run-actions.ts share via
// `stepFiresRendererGate`).
//
// PURE (no DB / React): only real HITL renderer gates appear — steps with an
// xRenderer that are NOT #839 metadata-only phantom gateSteps. Tooltip
// descriptions (which need an async sub-agent lookup) are decorated by the caller
// from the returned `_policyDescription`; the review surface does not need them.
// ---------------------------------------------------------------------------

import { stepFiresRendererGate } from "./orchestrator-gate-predicate";
import type { StepperStep } from "./orchestrator-stepper-panel";

/** The subset of an `approvalPolicy.steps[]` entry this projection reads. */
export type RunStepperPolicyStep = {
  stepNumber: number;
  xRenderer?: string;
  firesRendererGate?: boolean;
  name?: string;
  description?: string;
  childAgent?: { packageName?: string };
};

/** A projected stepper step, carrying the raw policy description so the caller
 * can layer sub-agent tooltip copy on top (instance-screens) or ignore it (the
 * review surface). */
export type ProjectedStepperStep = StepperStep & { _policyDescription: string | null };

/**
 * Project an approval policy's steps into the run's display stepper steps. The
 * sequential `index` (1-based) is the display order; `stepNumber` is the policy
 * step number the live resolver keys on. Identical walk to the one the run-detail
 * panel used inline, extracted so the review surface renders the same list.
 */
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

export function buildRunStepperSteps(
  policySteps: readonly RunStepperPolicyStep[],
): ProjectedStepperStep[] {
  return policySteps
    .filter((s) => stepFiresRendererGate(s as { xRenderer?: string; firesRendererGate?: boolean }))
    .map((s, i) => ({
      index: i + 1,
      stepNumber: s.stepNumber,
      xRenderer: s.xRenderer,
      childAgentPackageName: s.childAgent?.packageName,
      label: s.name ?? s.description ?? `Step ${s.stepNumber}`,
      _policyDescription: s.description ?? null,
    }));
}
