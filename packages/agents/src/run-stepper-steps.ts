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
      label: runStepLabel(s),
      _policyDescription: s.description ?? null,
    }));
}

/**
 * THE RAIL NAMES THE STEP, NOT ITS POSITION (cinatra#3046).
 *
 * The ratified drawing's run surface is explicit that "a step rail down the left
 * names the run's ordered steps". This projection named a step three ways and
 * the third was not a name at all: with no `name` and no `description` on the
 * policy step, the rail drew `Step 1` — the ordinal it is already drawing beside
 * the label, printed twice, once as the numeral and once as the words. Measured
 * on both palettes of the reshoot: the run page's rail named its work step
 * `Step 1`.
 *
 * SO THE STEP'S OWN NAME IS ASKED FOR ONE RUNG FURTHER DOWN before the ordinal
 * is accepted as one. A step that delegates to a child agent IS that agent's
 * step, and the package it names is a fact about the step rather than a label
 * invented for it — so it is humanized into the rail's register the same way the
 * surface humanizes every other identifier it draws: the npm scope dropped, the
 * separators spaced, the first letter raised. Nothing else about the package is
 * read, and a package whose name is empty after that is not a name.
 *
 * THE ORDINAL STAYS AS THE LAST RUNG, honestly. A step with no name, no
 * description and no child agent has nothing to be called, and inventing a word
 * for it would be worse than the numeral: the numeral is at least true.
 */
export function runStepLabel(step: RunStepperPolicyStep): string {
  const named = step.name?.trim() || step.description?.trim();
  if (named) return named;
  const fromChild = childAgentStepName(step.childAgent?.packageName);
  if (fromChild) return fromChild;
  return `Step ${step.stepNumber}`;
}

/** A child agent's package name, in the rail's register. `null` when there is
 *  nothing left to read after the scope is dropped. */
function childAgentStepName(packageName: string | undefined): string | null {
  if (!packageName) return null;
  const bare = packageName.includes("/")
    ? packageName.slice(packageName.lastIndexOf("/") + 1)
    : packageName;
  const words = bare.replace(/[-_.]+/g, " ").trim();
  if (words.length === 0) return null;
  return words.charAt(0).toUpperCase() + words.slice(1);
}
