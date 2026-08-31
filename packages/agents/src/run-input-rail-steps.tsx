// ---------------------------------------------------------------------------
// THE RUN'S INPUT FORMS, AS RAIL ROWS (cinatra#3068).
//
// The run page's other gate steps draw their own rows because each carries
// anchors a capture walk measures by name (`ScheduleRailStepRow`,
// `RecommendationRailStepRow`). An input form carries none: its row is a
// numeral and the form's own title. So it takes the SAME shared row every other
// nameless step takes (`RunSurfaceRailRow`), and this module is the mapping —
// the input step the model described, plus the row the rail draws for it. No
// rail is redesigned and no second row vocabulary is introduced.
//
// THE STEP OPENS NO SURFACE OF ITS OWN, deliberately. The form is drawn by the
// run panel in the detail column — it is bound to the run's live stream, its
// buffered values and its Continue, none of which a server-rendered surface can
// carry — so the OPEN step falls back to the run detail the screen composed.
//
// THE FALLBACK IS NOT THE SETTLED ROW'S SCREEN (cinatra#3068 convergence, and
// what fix leg 2 does with it). The fallback draws whatever the run detail
// currently holds, which is the form the run is asking RIGHT NOW: a settled
// "Idea" row that fell back would select Idea and display the live "Audience"
// question, breaking the rail's one contract, that the selected step shows THAT
// step's screen. The first leg answered that by CLOSING the settled row. The
// ratified drawing answers it the other way -- "A resolved gate opens
// read-only: what was decided" -- so the settled row now carries a screen of
// its own (`RunInputStepAnsweredReading`) and is opened rather than closed. A
// form the run has not reached yet is still drawn muted and opens nothing.
//
// WHY THE ROW IS BUILT HERE AND NOT IN THE SCREEN — the same reason
// `setup-run-surface-steps.tsx` gives: whether a row can be OPENED is the
// frame's own predicate, and two places computing it is two places to get it
// wrong. NO DIRECTIVE, deliberately: the screen is a server component,
// `RunSurfaceRailRow` is used as a JSX tag (which is what a client reference is
// for), and the predicate comes from the directive-free module beside it.
//
// THE DRAWING THIS SURFACE IS READ FROM, PINNED. The run surface is ratified in
// `specs/app-artifact-review.html` section I ("The agent run surface — steps,
// gates & detail"); the card an OPEN step draws is anatomised in
// `specs/app-lifecycle-cards.html` section V. Neither publishes a generated
// conformance manifest, so the pin is a recorded one:
//
//   ratified drawing pin: c73c68f5e39ed5b8da06b4dfd575ccf3692974c8
//
// It is recorded in `scripts/audit/chat-hitl-anchor-contract.json`
// (`runSurfaceDrawingPin`), which also records why that file's own
// `specCommit` is deliberately not moved with it. Every reading below — the
// entry that keeps its place, the settled row that opens read-only, the steps
// still to come — is read from section I at that commit.
// ---------------------------------------------------------------------------

import type { ReactNode } from "react";

import { RunInputStepAnsweredReading } from "./run-input-step-answered-reading";
import type { RunInputStep } from "./run-input-steps";
import { RunSurfaceRailRow } from "./run-surface-rail";
import {
  isRunSurfaceStepSelectable,
  type RunSurfaceRailStep,
} from "./run-surface-rail-step";

/**
 * The run's input forms as the rail's leading steps.
 *
 * `detail` is the run detail the screen composed, handed to the frame's own
 * predicate so the open row is still openable on the strength of what is behind
 * it — and closed where there is nothing, so no row ever opens an empty column.
 *
 * `displayOffset` is how many rows already stand above these; it is 0 on the
 * run page, where the input forms head the rail.
 */
export function buildRunInputRailSteps(
  steps: readonly RunInputStep[],
  detail: ReactNode,
  displayOffset = 0,
): RunSurfaceRailStep[] {
  return steps.map((step, index) => {
    const railStep: RunSurfaceRailStep = {
      key: step.key,
      // THE SETTLED STEP'S OWN SCREEN, and only its own. An OPEN form is drawn
      // by the run panel in the detail column -- it is bound to the run's live
      // stream, its buffered values and its Continue, none of which a
      // server-rendered surface can carry -- so the open step keeps falling
      // back to the run detail the screen composed.
      surface: step.settled ? (
        <RunInputStepAnsweredReading label={step.label} answers={step.answers} />
      ) : null,
      reached: step.reached,
      settled: step.settled,
      // THE PAGE'S OWN OVERRIDE, for the fact the frame cannot see: the run
      // detail behind this row holds ONE form, and it is the OPEN step's. So a
      // step opens when it is the open one -- whose screen that detail is -- or
      // when it is settled and carries the read-only reading above.
      selectable: step.open || step.settled,
      row: null,
    };
    const selectable = isRunSurfaceStepSelectable(railStep, detail);
    return {
      ...railStep,
      row: (
        <RunSurfaceRailRow
          selectionKey={step.key}
          label={step.label}
          displayStep={index + 1 + displayOffset}
          reached={step.reached}
          settled={step.settled}
          selectable={selectable}
          conformanceId="run-surface-rail-step"
          indicatorConformanceId="run-surface-rail-indicator"
          // The walk's vocabulary is "what pressing this does". A form the run
          // is not asking does not carry `open-…-step`, because a reader that
          // found it would be told the row opens the step.
          action={selectable ? "open-input-step" : "input-step-unavailable"}
        />
      ),
    };
  });
}
