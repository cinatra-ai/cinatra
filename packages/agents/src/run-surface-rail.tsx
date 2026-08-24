"use client";

// ---------------------------------------------------------------------------
// THE RUN SURFACE'S TWO COLUMNS, FOR A RUN THAT IS STILL BEING SET UP
// (cinatra#2970, epic #2784).
//
// The ratified drawing `design-run-surface-rail-and-gate.png`: "The surface is a
// two-column frame: a step rail down the left names the run's ordered steps, and
// the run detail on the right shows the selected step … Selecting a step opens
// it on the right … right here in the run detail, under the same rail, never as
// a standalone document."
//
// Plan (A) §7.2 step 5 and §7.4 step 7 say the same for the schedule step in
// particular — "it opens to the right of the steps, never directly under a step,
// and no agentic run progress card is shown with it" — and §6.2 says an agentic
// run progress card is not visible while the recommended skills can be selected.
//
// WHY THIS MODULE EXISTS. `ScheduleRailStep` already draws that frame for a run
// that CARRIES a schedule: its row heads the left column and the schedule's
// surface opens in the right one. The setup run page — the run page before the
// agent has ever run — drew none of it: one centred column with the scheduling
// form in it and no steps named anywhere. The frame is the same on both, so it
// is drawn ONCE here and composed by both rather than written a second time:
// `ScheduleRailStep` takes its ROW from here, and the setup surface takes the
// whole frame.
//
// WHAT IT DOES NOT DO. It invents no step, no label and no surface. The caller
// hands it the steps and each step's own surface; this module decides only which
// column each of them lands in and which one is open. A step whose surface is
// not drawn yet opens an empty run detail rather than a placeholder — the plan
// draws no "not reached yet" screen and nothing may be invented for one.
// ---------------------------------------------------------------------------

import { useState, type ReactElement, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The rail labels, transcribed from the ratified drawing's own rail rather than
 * chosen here: the drawing's rows read "Recommendation" and "Review", and plan
 * (A) §7.2 step 5 names the schedule's row "the schedule … a dedicated step in
 * the step rail". One source, so the setup rail and the schedule step cannot
 * drift into two vocabularies for the same row.
 */
export const RUN_SURFACE_RAIL_LABELS = {
  schedule: "Schedule",
  recommendation: "Recommendation",
  review: "Review",
} as const;

/**
 * ONE RAIL ROW: the circle, the title, and the selected state.
 *
 * Lifted OUT of `schedule-rail-step.tsx` unchanged — the same shadcn `<Button>`
 * (the design-system boundary admits no raw control JSX outside the vendored
 * primitives), the same `ghost` + size/hover neutralisers that keep a rail row
 * looking like a rail row rather than a pill, and the same selected/unselected
 * token pair `RunStepRailPanel` gives its rows. It draws its own indicator
 * instead of borrowing the stepper context for the reason that file states:
 * `StepperIndicator` reads the step-item context, so a row built from it can
 * only live inside a `<Stepper>`, and these rows have to head rails that are
 * different components with different lifetimes.
 *
 * The caller passes the row's OWN anchors through `rowAttributes` (the schedule
 * row keeps every attribute the capture walk and the tests already measure on
 * it); the shared marks below are what lets one selector count the rows of any
 * rail drawn from this module.
 */
export function RunSurfaceRailRow({
  label,
  displayStep,
  selected,
  onSelect,
  conformanceId,
  indicatorConformanceId,
  action,
  rowAttributes,
  available,
}: {
  label: string;
  /** The numeral the circle shows — the row's 1-based position in its rail. */
  displayStep: number;
  selected: boolean;
  onSelect: () => void;
  /**
   * Has the run REACHED this step? A step it has not reached is drawn the way
   * `RunStepRailPanel` already draws an upcoming row — the muted indicator, no
   * emphasis — so the rail says out loud which steps are still ahead.
   *
   * `undefined` is a THIRD answer and not a synonym for either: the caller does
   * not state it. The row is then drawn plainly and carries no reached mark at
   * all, because a rail that guessed would be making a claim about the run that
   * its page never read.
   */
  available?: boolean;
  /** The row's own conformance id, so a capture can address exactly this row. */
  conformanceId: string;
  /** The indicator's conformance id, where the caller measures the circle. */
  indicatorConformanceId?: string;
  /** The row's `data-action` — what pressing it does, in the walk's vocabulary. */
  action: string;
  /** Anchors that belong to THIS row's own host, added verbatim. */
  rowAttributes?: Record<string, string>;
}): ReactElement {
  return (
    <Button
      type="button"
      variant="ghost"
      data-run-surface-rail-step=""
      data-run-surface-rail-selected={selected ? "true" : "false"}
      data-run-surface-rail-reached={available === undefined ? undefined : available ? "true" : "false"}
      data-conformance-id={conformanceId}
      data-action={action}
      aria-current={selected ? "step" : undefined}
      onClick={onSelect}
      className="h-auto justify-start gap-2 rounded-control px-0 py-0.5 text-left whitespace-normal hover:bg-transparent hover:opacity-90 dark:hover:bg-transparent"
      {...rowAttributes}
    >
      <span
        data-conformance-id={indicatorConformanceId}
        className={cn(
          "relative flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs",
          selected && available !== false
            ? "bg-primary text-primary-foreground"
            : "bg-muted-foreground/40 text-background",
        )}
      >
        {displayStep}
      </span>
      <span
        className={cn(
          "text-sm font-medium",
          selected && available !== false ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
    </Button>
  );
}

/** One entry of the rail, and the surface it opens in the run detail. */
export type RunSurfaceStep = {
  /** Stable identity — the React key, and the row's `data-action` stem. */
  key: string;
  label: string;
  /**
   * The step's OWN surface, exactly as its host composes it. `null` is a real
   * answer: a step the run has not reached yet has nothing drawn for it, and
   * this module will not invent a stand-in.
   */
  surface: ReactNode;
  /**
   * Has the run reached this step? Drives the row's reached/upcoming treatment
   * only — the row stays selectable either way, because the rail's own property
   * is that selecting a step opens THAT step on the right, and a step with
   * nothing drawn for it yet opens an empty run detail rather than a stand-in.
   *
   * LEAVE IT OUT where the page has not read the answer. An omitted `reached`
   * draws the row plainly and states nothing; only a page that actually read the
   * run's record may say "still ahead".
   */
  reached?: boolean;
};

/**
 * THE TWO-COLUMN RUN SURFACE: the step rail on the left, the selected step's
 * surface on the right.
 *
 * The columns carry the SAME anchors `ScheduleRailStep` gives them
 * (`run-step-rail-column`, `run-detail-column`, and the `run-surface` contract
 * root the run detail declares), so one capture recipe measures rail 1 /
 * detail 1 on every run-page state, the setup page included.
 *
 * ONLY THE SELECTED STEP IS DRAWN. Not hidden — not rendered: the run detail
 * shows the selected step, so nothing else is on the page beside it, which is
 * the clause §7.2 step 5 and §6.2 both state as "no agentic run progress card".
 * And no surface is ever drawn inside the rail column, which is the composition
 * the drawing rules out.
 */
export function RunSurfaceRail({
  steps,
  initialSelectedKey,
}: {
  steps: readonly RunSurfaceStep[];
  /** The step open on first paint. Defaults to the first row of the rail. */
  initialSelectedKey?: string;
}): ReactElement | null {
  const [selectedKey, setSelectedKey] = useState<string>(
    initialSelectedKey ?? steps[0]?.key ?? "",
  );
  if (steps.length === 0) return null;
  // `steps` is a FIXED list for the life of a page render — the screen builds it
  // server-side and hands it down — so the selected key cannot go missing under
  // the component. It is still resolved defensively rather than indexed: a key
  // that names no step falls back to the first row, so a caller that does change
  // the list mid-life gets the head of its rail, never a blank surface with no
  // row marked.
  const selected = steps.find((s) => s.key === selectedKey) ?? steps[0];

  return (
    <div
      className="flex items-start gap-6"
      data-run-detail-contract=""
      data-conformance-id="run-surface"
    >
      {/* THE LEFT COLUMN — the rail. Rows, and nothing but rows. */}
      <div
        data-conformance-id="run-step-rail-column"
        data-run-step-rail-column=""
        className="flex shrink-0 flex-col gap-2 pt-1"
      >
        {steps.map((step, i) => (
          <RunSurfaceRailRow
            key={step.key}
            label={step.label}
            displayStep={i + 1}
            selected={step.key === selected.key}
            available={step.reached}
            onSelect={() => setSelectedKey(step.key)}
            conformanceId="run-surface-rail-step"
            indicatorConformanceId="run-surface-rail-indicator"
            action={`open-${step.key}-step`}
            rowAttributes={{ "data-run-surface-rail-step-key": step.key }}
          />
        ))}
      </div>

      {/* THE RIGHT COLUMN — the run detail, showing the selected step. */}
      <div
        data-conformance-id="run-detail-column"
        data-run-detail-column=""
        data-run-surface-selected-step={selected.key}
        className="flex min-w-0 flex-1 flex-col gap-4"
      >
        {selected.surface}
      </div>
    </div>
  );
}
