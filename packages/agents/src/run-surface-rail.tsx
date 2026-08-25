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
// A STEP WITH NO SURFACE YET IS NOT SELECTABLE (cinatra#2970).
// The round this replaces let every row be opened, so a step the run has not
// reached opened an EMPTY run detail. cinatra#2970: "a step the run has not
// reached cannot be selected. Its row stays on the rail, muted, so the series is
// visible; clicking it does nothing; the scheduler stays open; the right column
// never shows an empty step surface." So the row is still drawn — the rail is
// the series of the run's steps and dropping a row would hide the series — but
// it is muted, it is marked `aria-disabled`, its `data-action` names the state
// it is in rather than an opening it cannot perform, and it carries no click
// handler at all. Nothing is invented in the run detail either: the surface it
// shows is a step's OWN surface or the frame draws no step.
//
// WHAT IT DOES NOT DO. It invents no step, no label and no surface. The caller
// hands it the steps and each step's own surface; this module decides only which
// column each of them lands in, which one is open, and which rows can be opened
// at all.
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
  selectable = true,
}: {
  label: string;
  /** The numeral the circle shows — the row's 1-based position in its rail. */
  displayStep: number;
  selected: boolean;
  onSelect: () => void;
  /**
   * Can this row be opened at all? A row whose step has no surface yet is drawn
   * — the rail is the run's series of steps and hiding a row would hide the
   * series — but it does not act: no click handler that changes the selection,
   * `aria-disabled` so assistive technology is told the same thing the muted
   * tokens say, and the muted treatment whether or not anything else is
   * selected (cinatra#2970).
   *
   * Defaults to TRUE, so the one caller that draws a row of its own
   * (`ScheduleRailStep`, whose step always has its form) keeps exactly the row
   * it had.
   */
  selectable?: boolean;
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
  /** The row's `data-action` — what pressing it does, in the walk's vocabulary.
   *  A row that cannot be opened is handed the name of THAT state instead, so a
   *  walk (or a suite) selecting `open-<key>-step` finds no element it cannot
   *  actually press. */
  action: string;
  /** Anchors that belong to THIS row's own host, added verbatim. */
  rowAttributes?: Record<string, string>;
}): ReactElement {
  // The emphasised treatment is for the row the surface is actually on. A row
  // that cannot be opened never gets it — and neither does a row its page has
  // said the run has not reached, which is the pairing this row already had.
  const emphasised = selected && selectable && available !== false;
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
      aria-disabled={selectable ? undefined : "true"}
      // `aria-disabled`, NOT the native `disabled`. Native `disabled` takes the
      // row out of the tab order, so keyboard focus could not reach the row —
      // and "its row stays on the rail, so the series is visible" is precisely
      // what cinatra#2970 keeps. `aria-disabled` leaves the row in the tab order
      // and announces it as unavailable when focus arrives on it.
      //
      // What `aria-disabled` does NOT do on its own is stop the row acting, so
      // that is done here explicitly: no handler is attached, and the press
      // animation the shared button gives every control is neutralised below.
      // A press — by pointer, or by the Enter/Space that a focused button turns
      // into one — then does nothing and looks like nothing.
      onClick={selectable ? onSelect : undefined}
      className={cn(
        "h-auto justify-start gap-2 rounded-control px-0 py-0.5 text-left whitespace-normal hover:bg-transparent dark:hover:bg-transparent",
        // A row that does nothing offers neither the hover affordance nor the
        // press animation of a row that does.
        selectable
          ? "hover:opacity-90"
          : "cursor-default hover:opacity-100 active:not-aria-[haspopup]:translate-y-0",
      )}
      {...rowAttributes}
    >
      <span
        data-conformance-id={indicatorConformanceId}
        className={cn(
          "relative flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs",
          emphasised
            ? "bg-primary text-primary-foreground"
            : "bg-muted-foreground/40 text-background",
        )}
      >
        {displayStep}
      </span>
      <span
        className={cn(
          "text-sm font-medium",
          emphasised ? "text-foreground" : "text-muted-foreground",
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
   * this module will not invent a stand-in. A step that answers `null` cannot
   * be opened — see `isRunSurfaceStepSelectable`.
   */
  surface: ReactNode;
  /**
   * Has the run reached this step? Drives the row's reached/upcoming treatment,
   * AND — since cinatra#2970 — whether the row can be opened at all: a step
   * the page has read as still ahead has no surface to open, so selecting it
   * could only produce an empty run detail.
   *
   * LEAVE IT OUT where the page has not read the answer. An omitted `reached`
   * draws the row plainly, states nothing, and leaves the row selectable —
   * silence is not a claim that the run is still short of the step, and turning
   * it into one would close a row on a guess.
   */
  reached?: boolean;
};

/**
 * IS THIS STEP SELECTABLE? (cinatra#2970.)
 *
 * A step the run has not reached HAS NO SURFACE TO OPEN, so opening it can only
 * produce an empty run detail. cinatra#2970 names that outcome and rules it
 * out: "a step the run has not reached cannot be selected. Its row stays on
 * the rail,
 * muted, so the series is visible; clicking it does nothing; the scheduler stays
 * open; the right column never shows an empty step surface."
 *
 * The predicate is the two facts the caller already hands down, and nothing is
 * inferred beyond them:
 *
 *   • the step's surface EXISTS — `null` is this module's documented "there is
 *     nothing drawn for this step yet", so a step carrying one cannot be opened
 *     onto;
 *   • and, WHERE THE PAGE READ IT, the run has reached the step.
 *
 * `reached` stays the THIRD answer it already was. Unstated is not "no": a page
 * that never read whether the run reached a step makes no claim about it, and a
 * rail that turned silence into "still ahead" would be inventing exactly the
 * claim the field's own contract forbids. So unstated leaves the row
 * selectable, and only an explicit `reached: false` closes it.
 *
 * The schedule row is selectable under this one rule wherever it is drawn — its
 * surface is the scheduling form, which always exists, and no page claims the
 * run is still short of the step it is standing on. It is asserted rather than
 * special-cased, so the rail has one rule and no privileged key.
 */
export function isRunSurfaceStepSelectable(step: RunSurfaceStep): boolean {
  const hasSurface =
    step.surface !== null && step.surface !== undefined && step.surface !== false;
  return hasSurface && step.reached !== false;
}

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
 *
 * AND THE SELECTED STEP ALWAYS CARRIES A SURFACE. Selection can only ever land
 * on a selectable step: an unselectable row carries no handler, and an
 * `initialSelectedKey` naming a step with no surface falls through to the first
 * row that has one rather than opening the empty column cinatra#2970 forbids.
 *
 * WHAT THAT DOES NOT REACH. "Carries a surface" is as far as this rail can see.
 * A surface that is a component ELEMENT is a non-null value however the
 * component itself later resolves, so a step whose surface renders nothing can
 * still be opened onto an empty run detail. That is a real gap against the
 * rule's last clause and it is not closed here: closing it needs the surface's
 * own resolved state to reach the rail, which is a change to the component that
 * owns that state, not to this module. It is carried as a named residual.
 */
export function RunSurfaceRail({
  steps,
  initialSelectedKey,
}: {
  steps: readonly RunSurfaceStep[];
  /** The step open on first paint. Defaults to the first SELECTABLE row of the
   *  rail, and falls back to it when the named step has no surface. */
  initialSelectedKey?: string;
}): ReactElement | null {
  const [selectedKey, setSelectedKey] = useState<string>(() =>
    resolveSelectable(steps, initialSelectedKey)?.key ?? "",
  );
  if (steps.length === 0) return null;
  // `steps` is a FIXED list for the life of a page render — the screen builds it
  // server-side and hands it down — so the selected key cannot go missing under
  // the component. It is still resolved defensively rather than indexed: a key
  // that names no step, or names one whose surface does not exist, falls back to
  // the first row that CAN be opened, so a caller that does change the list
  // mid-life gets a real step, never the empty detail column.
  //
  // `null` is reachable only for a rail whose every step is unselectable, which
  // no caller composes (a rail always carries the step the page is on). It is
  // still handled honestly: no row is marked selected and the run detail draws
  // nothing, rather than a row claiming to be open over an empty surface.
  const selected = resolveSelectable(steps, selectedKey);

  return (
    <div
      className="flex items-start gap-6"
      data-run-detail-contract=""
      data-conformance-id="run-surface"
    >
      {/* THE LEFT COLUMN — the rail. Rows, and nothing but rows. Every step is
          a row, the ones still ahead included: the rail is the run's series of
          steps, so a step that cannot be opened is still named. */}
      <div
        data-conformance-id="run-step-rail-column"
        data-run-step-rail-column=""
        className="flex shrink-0 flex-col gap-2 pt-1"
      >
        {steps.map((step, i) => {
          const selectable = isRunSurfaceStepSelectable(step);
          return (
            <RunSurfaceRailRow
              key={step.key}
              label={step.label}
              displayStep={i + 1}
              selected={step.key === selected?.key}
              available={step.reached}
              selectable={selectable}
              onSelect={() => setSelectedKey(step.key)}
              conformanceId="run-surface-rail-step"
              indicatorConformanceId="run-surface-rail-indicator"
              // The walk's vocabulary is "what pressing this does". A row that
              // cannot be opened does not carry `open-<key>-step`, because a
              // reader that found it would be told the row opens the step.
              action={selectable ? `open-${step.key}-step` : `${step.key}-step-unavailable`}
              rowAttributes={{ "data-run-surface-rail-step-key": step.key }}
            />
          );
        })}
      </div>

      {/* THE RIGHT COLUMN — the run detail, showing the selected step. */}
      <div
        data-conformance-id="run-detail-column"
        data-run-detail-column=""
        data-run-surface-selected-step={selected?.key}
        className="flex min-w-0 flex-1 flex-col gap-4"
      >
        {selected?.surface}
      </div>
    </div>
  );
}

/**
 * The step a given key resolves to: the named one when it exists AND can be
 * opened, otherwise the first row of the rail that can be. Kept out of the
 * component so first paint and every later render answer the same question the
 * same way.
 */
function resolveSelectable(
  steps: readonly RunSurfaceStep[],
  key: string | undefined,
): RunSurfaceStep | null {
  const named = steps.find((s) => s.key === key);
  if (named && isRunSurfaceStepSelectable(named)) return named;
  return steps.find(isRunSurfaceStepSelectable) ?? null;
}
