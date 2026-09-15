// ---------------------------------------------------------------------------
// THE REVIEW PAGE'S RUN SURFACE — its gate steps, and the two columns they head
// (cinatra#3047, the re-shoot's first and second defects).
//
// ONE PAGE PER GATE, AND THE REVIEW PAGE IS ONE OF THE RUN'S PAGES. The ratified
// drawing at the capture contract's pin puts the Skills question at the head of
// the rail on the run surface and gives it a page of its own — "the Skills step
// is a page of its own, and the schedule step is a page of its own — each opened
// by selecting its own entry on the rail … neither step is a region of one
// screen the two share" — and its own rail illustrations of THIS route draw the
// Skills entry first, settled, above the run's steps and the gated Review row.
// The change request says the same thing about what must not happen: "Do not
// show the skills on top of the review card or the schedule card or any other
// card either."
//
// WHAT WAS WRONG, and why it survived the run page's own fix. This route is a
// SECOND composition of the run surface, in a different file from
// `instance-screens.tsx`, and the earlier legs of cinatra#3047 moved only the
// run page's mount. Here the card was still mounted straight into the gate
// region, ABOVE the review card, and the rail carried no Skills entry at all —
// the re-shoot photographed both at once: one `[data-run-recommendation-chip-
// row]` inside `[data-run-detail-column]`, in the retired settled chip reading,
// over a rail reading "1 Schedule / 2 Review".
//
// WHY THE COMPOSITION IS A MODULE AND NOT INLINE IN THE PAGE. The row a gate
// step gets, the numeral it carries and whether it can be opened are the rail's
// own rules, and a page that restates them is a second place for them to drift —
// which is the shape of the defect this closes. `buildSetupRailSteps` exists for
// the same reason on the setup run page. The page reads the run's facts and
// hands them here; this module owns the frame.
//
// THE HOST IS THE PAGE'S OWN, UNCHANGED. Both gate steps declare
// `page_gate_region`, exactly as this route's gate region always did: the anchor
// contract's `hostParity` records `recommendation_hold` and
// `trigger_schedule_proposal` as reaching that host by composition, and moving
// the mount within the page must not move the host it is mounted under. What
// changed is WHERE on the page the step's surface opens, and the reading that
// host draws for it (`chipRowDrawsSkillChecklist`).
//
// NO DIRECTIVE. This is composed by the route's SERVER component, and every
// value it evaluates comes from a directive-free module
// (`runSurfaceRailNumerals`, `recommendationRailEntry`); the rail's components
// are used as JSX tags, which is exactly what a client reference is for.
// ---------------------------------------------------------------------------

import type { ReactElement, ReactNode } from "react";

import { LifecycleCardSurfaceProvider } from "@cinatra-ai/agents/lifecycle-card-runtime";
import { RecommendationHoldCard } from "@cinatra-ai/agents/run-recommendation-chip-row";
import { RecommendationRailStepRow } from "@cinatra-ai/agents/recommendation-rail-step";
import type { RecommendationRailEntry } from "@cinatra-ai/agents/recommendation-rail-entry";
import { ScheduleRailStepRow, ScheduleStepSurface } from "@cinatra-ai/agents/schedule-rail-step";
import { RunSurfaceRail } from "@cinatra-ai/agents/run-surface-rail";
import {
  runSurfaceRailNumerals,
  type RunSurfaceRailStep,
} from "@cinatra-ai/agents/run-surface-rail-step";

export function ReviewRunSurface({
  runId,
  recommendationEntry,
  recommendationStepOpens,
  scheduleCardRef,
  rail,
  detail,
}: {
  runId: string;
  /** Does this run's rail carry a Skills entry, and how does it read? Answered
   *  by `recommendationRailEntry` from the run's own park row — the same reader
   *  the run page and the setup run page ask, so the three rails cannot disagree
   *  about whether the question was ever asked. */
  recommendationEntry: RecommendationRailEntry;
  /** Can that entry be OPENED? A park the TTL sweeper left `policy_unresolved`
   *  is terminal without anybody having answered it, and the card draws no DOM
   *  for such a run — so the row stands on the rail, muted and closed, rather
   *  than opening onto nothing. `recommendationRailStepOpens` is the reader —
   *  and a decision that RACED that sweeper is still a decision, so the reader is
   *  asked with the run's own `recommendationDecidedForRun` answer rather than
   *  with the park's status alone (cinatra#3047, convergence). */
  recommendationStepOpens: boolean;
  /** The run-scoped schedule ref, minted by the page. `null` for a run with no
   *  schedule, which draws no schedule step at all rather than an empty one. */
  scheduleCardRef: string | null;
  /** The REST of the rail: this page's own step rows (`ReviewRunSteps`). */
  rail: ReactNode;
  /** The gate region as the page composes it — the review card and the run's
   *  own parked question, and nothing else. */
  detail: ReactNode;
}): ReactElement {
  // THE GATE STEPS, in the order the drawing puts them: the Skills question at
  // the head of the rail, then the schedule. Built before their rows, because
  // the numerals are a property of the SERIES rather than of any one row.
  const keys: RunSurfaceRailStep["key"][] = [];
  if (recommendationEntry !== "none") keys.push("recommendation");
  if (scheduleCardRef) keys.push("schedule");
  const numerals = runSurfaceRailNumerals(keys);

  const steps: RunSurfaceRailStep[] = [];
  if (recommendationEntry !== "none") {
    steps.push({
      key: "recommendation",
      // The row draws the drawing's own glyph on both readings and takes no
      // numeral — see `RunSurfaceRailStepGlyph`.
      // AND THE ROW SAYS WHETHER IT CAN BE OPENED (cinatra#3047, convergence).
      // The frame refuses a selection onto a step that opens onto nothing; a row
      // that went on naming `open-recommendation-step` anyway advertised a press
      // that did nothing, on the one page that can close this step.
      row: (
        <RecommendationRailStepRow
          settled={recommendationEntry === "settled" && recommendationStepOpens}
          openable={recommendationStepOpens}
        />
      ),
      // A TERMINAL PARK IS NOT A DECIDED ONE. `policy_unresolved` reads as
      // `settled` for the ENTRY — the row keeps its place — and nobody answered
      // it, so there is nothing for a completed circle to record and nothing
      // for the step to open. Same two reads the setup run page makes.
      reached: recommendationStepOpens,
      settled: recommendationEntry === "settled" && recommendationStepOpens,
      // THE ONE RENDERER OF THIS KIND, on the host this page declares — and it
      // is the step's surface and NOTHING else's. It used to be mounted in the
      // gate region beside the review card, which is the placement the drawing
      // forbids and the re-shoot photographed.
      surface: recommendationStepOpens ? (
        <LifecycleCardSurfaceProvider host="page_gate_region">
          <RecommendationHoldCard runId={runId} />
        </LifecycleCardSurfaceProvider>
      ) : null,
    });
  }
  if (scheduleCardRef) {
    steps.push({
      key: "schedule",
      row: (
        <ScheduleRailStepRow host="page_gate_region" displayStep={numerals[keys.indexOf("schedule")] ?? 1} />
      ),
      // The review page passes NO prompt window template: plan (A) §7.2's
      // "below the scheduler" names the run page, so this page's schedule step
      // is the scheduler alone. Unchanged by this composition.
      surface: <ScheduleStepSurface host="page_gate_region" cardRef={scheduleCardRef} />,
    });
  }

  // THE PAGE OPENS ON THE REVIEW CARD: the reviewer came here to decide it. The
  // gate steps are on the rail beside it, one press away, and only one of the
  // three surfaces is ever on screen.
  if (steps.length > 0) {
    return (
      <RunSurfaceRail steps={steps} rail={rail} detail={detail} initialSelection="detail" />
    );
  }
  // A run with no gate step at all keeps the inert two columns this page has
  // always drawn — no selection to make, and no frame to make it in.
  return (
    <>
      {rail}
      <div className="flex min-w-0 flex-1 flex-col gap-4">{detail}</div>
    </>
  );
}
