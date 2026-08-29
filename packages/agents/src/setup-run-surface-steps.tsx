// ---------------------------------------------------------------------------
// THE SETUP RUN PAGE'S RAIL ROWS (cinatra#2970, epic #2784).
//
// The run page's own gate steps draw their own rows — `ScheduleRailStepRow` and
// `RecommendationRailStepRow` each carry anchors a capture walk measures by
// name. The SETUP page's three steps carry none: each row is a numeral and a
// word. So one component draws all three (`RunSurfaceRailRow`) and this module
// is the mapping — the step the screen described, plus the row that step gets.
//
// WHY THE ROW IS BUILT HERE AND NOT IN THE SCREEN. The row a step gets depends
// on whether the step can be OPENED, and that is the frame's own predicate. Two
// places computing it is two places to get it wrong, and the failure is silent:
// a row promising `open-review-step` that the frame then refuses reads, to a
// walk and to a person, as a control that does nothing. One call site, and the
// suite drives the same one the screen does.
//
// NO DIRECTIVE, deliberately. `instance-screens.tsx` is a server component and
// calls this. `RunSurfaceRailRow` is used as a JSX TAG, which is exactly what a
// client reference is for; the predicate comes from the directive-free module
// beside it, because CALLING a client reference is not calling the function
// (`instance-screens-client-boundary.test.ts`).
// ---------------------------------------------------------------------------

import { RunSurfaceRailRow } from "./run-surface-rail";
import { RUN_SURFACE_RAIL_LABELS } from "./run-surface-rail-labels";
import {
  isRunSurfaceStepSelectable,
  type RunSurfaceRailLabelledKey,
  type RunSurfaceRailStep,
} from "./run-surface-rail-step";

/**
 * A setup step as the screen describes it: everything but its row.
 *
 * Its key is one of the three the rail NAMES, because this builder labels each
 * row from `RUN_SURFACE_RAIL_LABELS`. The run page's own input steps carry
 * their form's declared title instead and are built by
 * `run-input-rail-steps.tsx` (cinatra#3068).
 */
export type SetupRailStep = Omit<RunSurfaceRailStep, "row" | "key"> & {
  key: RunSurfaceRailLabelledKey;
};

/**
 * The same steps, each with the row the rail draws for it.
 *
 * The setup page composes no run detail of its own — the rail IS the page — so
 * the fallback handed to the predicate is `null`: a step with nothing drawn for
 * it has nothing to fall back to, and its row closes rather than opening the
 * empty column cinatra#2970 forbids.
 */
export function buildSetupRailSteps(
  steps: readonly SetupRailStep[],
): RunSurfaceRailStep[] {
  return steps.map((step, index) => {
    const selectable = isRunSurfaceStepSelectable(step, null);
    return {
      ...step,
      row: (
        <RunSurfaceRailRow
          selectionKey={step.key}
          label={RUN_SURFACE_RAIL_LABELS[step.key]}
          displayStep={index + 1}
          reached={step.reached}
          settled={step.settled}
          selectable={selectable}
          conformanceId="run-surface-rail-step"
          indicatorConformanceId="run-surface-rail-indicator"
          // The walk's vocabulary is "what pressing this does". A row that
          // cannot be opened does not carry `open-<key>-step`, because a reader
          // that found it would be told the row opens the step.
          action={selectable ? `open-${step.key}-step` : `${step.key}-step-unavailable`}
        />
      ),
    };
  });
}
