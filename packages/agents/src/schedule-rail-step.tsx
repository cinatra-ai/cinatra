"use client";

// ---------------------------------------------------------------------------
// THE SCHEDULE STEP OF THE RUN SURFACE (cinatra#2788, epic #2784 S9d).
//
// Plan: PLAN: Agents Lifecycle (A) §7.2 step 5 — "On the run page and the review
// page the schedule is a **dedicated step in the step rail on the left, above
// '1 Review'**: open that step to see the configuration or change it — it opens
// to the right of the steps, never directly under a step, and no agentic run
// progress card is shown with it. The schedule is never drawn as a card among
// the review cards — a trigger decides *when* the agent runs, and a review card
// exists only after the agent has run and produced something — so the two can
// never appear together." §7.4's as-designed step 7 says the same.
//
// The ratified drawing this composes (`design-run-surface-rail-and-gate.png`):
// "The surface is a two-column frame: a step rail down the left names the run's
// ordered steps, and the run detail on the right shows the selected step …
// Selecting a step opens it on the right … a gate step opens the gate's own
// surface in place — right here in the run detail, under the same rail, never as
// a standalone document."
//
// WHAT THIS FILE IS. The schedule's own two pieces of that frame: the rail ROW
// (circle, title, selected state — the shape the rail's other rows have) and, in
// the run detail, the surface it opens onto. The surface is
// `ScheduleProposalCard`, the one renderer of this kind on every host; this
// module is the run page's and the review page's ADAPTER for it — it declares
// the host and supplies the frame, exactly as the transcript's registry row
// does, which is why it is the module the one-card gate enumerates as their host
// mount.
//
// THE FRAME ITSELF MOVED OUT (cinatra#2790, S9f), and only the frame: the two
// columns, the selection between them and the row vocabulary now live in
// `run-surface-rail.tsx`, because plan (A) §6.2 puts a SECOND gate step — the
// recommendation — in the same rail, above this one. Two frames beside each
// other would be two rails. `ScheduleRailStep` below is the one-step case,
// unchanged in props and in DOM, and it is what the review page mounts; a screen
// that carries both steps composes `RunSurfaceRail` with both rows instead.
//
// THE STEP OPENS ON THE RIGHT, NOT UNDER THE ROW. An earlier round opened the
// configuration inside the rail column, directly under the row. That is the
// composition the drawing rules out and it was rejected: the rail names the
// steps, and the step's own surface belongs in the run detail beside it. So the
// row is a row — the whole configuration lives in the other column.
//
// AND NOTHING ELSE IS DRAWN BESIDE IT. Selecting a step shows THAT step; the
// run's progress is the surface of the run's own steps, so a run that has not
// executed has no progress to show and draws none. The screen decides which step
// is selected on first paint (`initialSelection`) and hands the run detail in as
// `detail`; this module never invents either.
//
// IT DRAWS ITS OWN INDICATOR RATHER THAN BORROWING THE STEPPER CONTEXT, and
// that is deliberate. `StepperIndicator` reads the step-item context, so a row
// built from it can only exist inside the one `<Stepper>` a rail already
// renders — and the two rails this step has to appear in are different
// components with different lifetimes (one server-rendered, one driven by the
// live run stream). Drawing the circle and the title from the SAME size, radius
// and muted-foreground tokens the rail rows use is what lets one component be
// the first row of both rails without either of them having to take it as a
// child. The rails renumber around it (`stepOffset`), which is what makes it
// "above '1 Review'" rather than a second row numbered 1.
// ---------------------------------------------------------------------------

import { useEffect, useState, type ReactElement, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

import { LifecycleCardSurfaceProvider } from "./lifecycle-card-runtime";
import { ScheduleProposalCard } from "./schedule-proposal-card";
import { SchedulePromptWindow } from "./schedule-prompt-window";
import { LIFECYCLE_VIEW_SCHEMA_VERSION } from "./review-gate-card";
import {
  RUN_SURFACE_RAIL_ROW_CLASS,
  RunSurfaceRail,
  runSurfaceRailIndicatorClass,
  runSurfaceRailTitleClass,
  useRunStepSelection,
} from "./run-surface-rail";

/** The label the rail row carries. One word, in the plan's own vocabulary —
 *  "the schedule is a dedicated step in the step rail". */
export const SCHEDULE_RAIL_STEP_LABEL = "Schedule";

// The selection type and its reader are the FRAME's, re-exported here because
// this module's subpath is the one the review page's rail already imports them
// from (`@cinatra-ai/agents/schedule-rail-step`). One definition, two names for
// the same import site.
export type { RunStepSelection } from "./run-surface-rail";
export { useRunStepSelection } from "./run-surface-rail";

/**
 * THE SCHEDULE'S RAIL ROW. Drawn in the rail column; its surface is not.
 */
export function ScheduleRailStepRow({
  host,
  displayStep,
}: {
  /** Which page this rail belongs to. The two page hosts are the only
   *  callers: a transcript has no rail, and its card is served by the registry
   *  row. */
  host: "run_card" | "page_gate_region";
  /** The numeral this row shows — its position among the rail's gate steps. */
  displayStep: number;
}): ReactElement {
  const selection = useRunStepSelection();
  const scheduleSelected = selection?.selected === "schedule";

  return (
    <Button
      type="button"
      variant="ghost"
      data-conformance-id="schedule-rail-step"
      data-schedule-rail-step=""
      data-schedule-rail-host={host}
      data-schedule-step-selected={scheduleSelected ? "true" : "false"}
      data-action="open-schedule-step"
      aria-current={scheduleSelected ? "step" : undefined}
      onClick={() => selection?.select("schedule")}
      className={RUN_SURFACE_RAIL_ROW_CLASS}
    >
      <span
        data-conformance-id="schedule-rail-indicator"
        className={runSurfaceRailIndicatorClass(Boolean(scheduleSelected))}
      >
        {displayStep}
      </span>
      <span className={runSurfaceRailTitleClass(Boolean(scheduleSelected))}>
        {SCHEDULE_RAIL_STEP_LABEL}
      </span>
    </Button>
  );
}

/**
 * HAS THE SCHEDULER ACTUALLY BEEN DRAWN in this step (cinatra#2972)?
 *
 * `ScheduleProposalCard` renders NO DOM AT ALL for a run its resolver answers
 * `absent` for — a run whose schedule was set on the run's own scheduling step
 * rather than stated in a conversation, which is most of them today. That empty
 * step is a pre-existing gap this slice does not close.
 *
 * What this slice must not do is WIDEN it, and without this gate it would: the
 * prompt window would stand alone in the otherwise-empty column, a prompt about
 * a scheduler that is not there. Plan (A) §7.2 as amended 2026-08-25 puts the
 * window "below the scheduler", so where there is no scheduler there is no
 * window.
 *
 * IT IS MEASURED, NOT PREDICTED. The card resolves after mount and the surface
 * around it cannot ask it what it decided, so the honest reading is the DOM it
 * produced. `MutationObserver` is what makes that reading LIVE — a card that
 * resolves late, or re-resolves into `absent`, moves the window with it.
 */
function useSchedulerDrawn(host: HTMLElement | null): boolean {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    if (!host) {
      setDrawn(false);
      return;
    }
    const read = () => setDrawn(host.childElementCount > 0);
    read();
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(read);
    observer.observe(host, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [host]);
  return drawn;
}

/**
 * THE SCHEDULE STEP'S SURFACE — the configuration, and nothing else.
 *
 * The same component the chat thread, the widget and the other page mount — the
 * option rows, the estimated duration, Save changes, and (because this IS the
 * page's schedule step) the two operations Cancel schedule and Run now. There is
 * no summary box and no status label above the form: plan (A) §7.2 — "The
 * schedule step on the run page and the review page shows the same form and
 * nothing else — no summary box, no status label; its two controls are **Cancel
 * schedule** and **Run now**". The card draws NO DOM at all for a run no
 * proposal produced, so an ordinary run shows the row and an empty column rather
 * than an invented one.
 *
 * AND, WHERE THE PAGE ASKS FOR ONE, THE PROMPT WINDOW UNDER IT (cinatra#2972) —
 * see `promptWindowTemplateId`.
 *
 * THE HOST IS DECLARED BY NAME, ONCE PER PAGE, rather than threaded through as
 * `host={host}`. Two readers depend on a LITERAL declaration and neither can
 * follow a prop: the one-card gate's R3 check that a module mounting a card
 * carries a provider, and the host-parity ratchet's composition scan, which
 * reads `<LifecycleCardSurfaceProvider host="…">` blocks out of production
 * sources to see which host really draws which owner. A prop would read to both
 * of them as "no host declared", and the card's own runtime would then draw
 * nothing at all.
 */
export function ScheduleStepSurface({
  host,
  cardRef,
  promptWindowTemplateId = null,
}: {
  /** Which page this rail belongs to. The two page hosts are the only
   *  callers: a transcript has no rail, and its card is served by the registry
   *  row. */
  host: "run_card" | "page_gate_region";
  /** The run-scoped schedule ref, minted server-side by the page. */
  cardRef: string;
  /**
   * The template the schedule step's PROMPT WINDOW asks its questions about
   * (cinatra#2972). Plan (A) §7.2 as amended 2026-08-25: "The run page's prompt
   * window shows below the scheduler."
   *
   * A prop rather than a fixed mount, because the plan names the RUN PAGE: the
   * run page passes the template and gets the window, the review page passes
   * `null` and its schedule step is the scheduler alone. One composition, one
   * decision, made by the page that the plan names.
   */
  promptWindowTemplateId?: string | null;
}): ReactElement {
  const [cardHost, setCardHost] = useState<HTMLElement | null>(null);
  const schedulerDrawn = useSchedulerDrawn(cardHost);
  const cardView = {
    viewType: "trigger_schedule_proposal" as const,
    schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION,
    ref: cardRef,
  };
  return (
    <div data-conformance-id="schedule-step-detail">
      <div data-schedule-card-host="" ref={setCardHost}>
        {host === "run_card" ? (
          <LifecycleCardSurfaceProvider host="run_card">
            <ScheduleProposalCard view={cardView} />
          </LifecycleCardSurfaceProvider>
        ) : (
          <LifecycleCardSurfaceProvider host="page_gate_region">
            <ScheduleProposalCard view={cardView} />
          </LifecycleCardSurfaceProvider>
        )}
      </div>
      {/* AND THE PROMPT WINDOW UNDER IT (cinatra#2972). Plan (A) §7.2 as
          amended 2026-08-25: "The run page's prompt window shows below the
          scheduler." It is drawn HERE — after the card, inside the run detail
          column — rather than at the end of the page, which is where the
          Trigger tab's own mount puts it. The window portals into its own div,
          so "below the scheduler" is where it actually lands and not only where
          it is written.

          AND ONLY WHERE THERE IS A SCHEDULER TO BE BELOW. The card draws
          nothing for a run its resolver answers `absent` for; a window alone in
          that empty column would be a prompt about a form that is not there. */}
      {promptWindowTemplateId && schedulerDrawn ? (
        <SchedulePromptWindow templateId={promptWindowTemplateId} />
      ) : null}
    </div>
  );
}

/**
 * The ONE-STEP surface: the frame with the schedule as its only gate step.
 *
 * This is what the review page mounts, and what a run page carrying a schedule
 * and no recommendation mounts. Props and DOM are unchanged by the frame's move.
 */
export function ScheduleRailStep({
  host,
  cardRef,
  displayStep,
  rail = null,
  detail = null,
  initialSelection = "schedule",
  promptWindowTemplateId = null,
}: {
  /** Which page this rail belongs to. The two page hosts are the only
   *  callers: a transcript has no rail, and its card is served by the registry
   *  row. */
  host: "run_card" | "page_gate_region";
  cardRef: string;
  /** The numeral this row shows — 1, because the schedule step sits above the
   *  run's other steps and above "1 Review" (§7.2 step 5). */
  displayStep: number;
  /** The REST of the rail: the page's own step rows, drawn under this one. */
  rail?: ReactNode;
  /** The run detail as the page composes it — shown when a step other than the
   *  schedule is selected. */
  detail?: ReactNode;
  /**
   * The step selected on first paint. The screen decides it, because only the
   * screen knows whether the agent has run: with no execution record there is no
   * progress to open onto and the schedule step is the selected one (§7.2 step
   * 5); once the run has fired, the run's own detail is what the page opens on.
   */
  initialSelection?: "schedule" | "detail";
  /**
   * The template the schedule step's PROMPT WINDOW asks its questions about
   * (cinatra#2972). Plan (A) §7.2 as amended 2026-08-25: "The run page's prompt
   * window shows below the scheduler." Threaded straight through to
   * `ScheduleStepSurface`, which is where the window is drawn.
   *
   * A prop rather than a fixed mount, because the plan names the RUN PAGE: the
   * run page passes the template and gets the window, the review page passes
   * `null` and its schedule step is the scheduler alone. One composition, one
   * decision, made by the page that the plan names.
   */
  promptWindowTemplateId?: string | null;
}): ReactElement {
  return (
    <RunSurfaceRail
      steps={[
        {
          key: "schedule",
          row: <ScheduleRailStepRow host={host} displayStep={displayStep} />,
          surface: (
            <ScheduleStepSurface
              host={host}
              cardRef={cardRef}
              promptWindowTemplateId={promptWindowTemplateId}
            />
          ),
        },
      ]}
      rail={rail}
      detail={detail}
      initialSelection={initialSelection}
    />
  );
}
