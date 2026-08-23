"use client";

// ---------------------------------------------------------------------------
// THE SCHEDULE STEP IN THE STEP RAIL (cinatra#2788, epic #2784 S9d).
//
// Plan: PLAN: Agents Lifecycle (A) §7.2 step 5 — "On the run page and the review
// page the schedule is a **dedicated step in the step rail on the left, above
// '1 Review'**: open that step to see the configuration or change it. The
// schedule is never drawn as a card among the review cards — a trigger decides
// *when* the agent runs, and a review card exists only after the agent has run
// and produced something — so the two can never appear together." §7.4's
// as-designed step 7 says the same, and §9's table row makes it this slice's.
//
// WHAT THIS FILE IS. The rail ROW plus the disclosure panel the row opens, and
// nothing else: the configuration inside the panel is `ScheduleProposalCard`,
// the one renderer of this kind on every host. This component is the run page's
// and the review page's ADAPTER for that card — it declares the host and it
// supplies the frame, exactly as the transcript's registry row does, which is
// why it is the module the one-card gate enumerates as their host mount.
//
// WHY IT IS NOT IN THE GATE REGION ANY MORE. It used to be: the review page
// mounted the schedule card beside the review card inside one
// `LifecycleCardSurfaceProvider host="page_gate_region"`, and the run page
// mounted it in the trigger screen's body. Both drew a composition the plan does
// not contain — the schedule beside the review. The plan text quoted above is
// what governs, and it is quoted rather than summarised for that reason. So the mount moved into the rail, on both
// pages, and the gate region holds the review card alone.
//
// IT DRAWS ITS OWN INDICATOR RATHER THAN BORROWING THE STEPPER CONTEXT, and
// that is deliberate. `StepperIndicator` reads the step-item context, so a row
// built from it can only exist inside the one `<Stepper>` a rail already
// renders — and the two rails this step has to appear in are different
// components with different lifetimes (one server-rendered, one driven by the
// live run stream). Drawing the circle and the title here, from the SAME size,
// radius and muted-foreground tokens the rail rows use, is what lets one
// component be the first row of both rails without either of them having to
// take it as a child. The rails renumber around it (`stepOffset`), which is what
// makes it "above '1 Review'" rather than a second row numbered 1.
//
// THE PANEL OPENS INSIDE THE RAIL COLUMN. A rail is a narrow column, so the
// panel carries its own width and the column grows around it while it is open.
// That keeps "opening the step shows the configuration" literally true — the
// configuration is inside the step — instead of turning the rail row into a link
// that puts a card back where the plan just took one away from.
// ---------------------------------------------------------------------------

import { useState, type ReactElement } from "react";
import { CalendarClock, ChevronDown, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";

import { LifecycleCardSurfaceProvider } from "./lifecycle-card-runtime";
import { ScheduleProposalCard } from "./schedule-proposal-card";
import { LIFECYCLE_VIEW_SCHEMA_VERSION } from "./review-gate-card";

/** The label the rail row carries. One word, in the plan's own vocabulary —
 *  "the schedule is a dedicated step in the step rail". */
export const SCHEDULE_RAIL_STEP_LABEL = "Schedule";

export function ScheduleRailStep({
  host,
  cardRef,
  displayStep,
  defaultOpen = false,
}: {
  /** Which page this rail belongs to. The two page hosts are the only callers:
   *  a transcript has no rail, and its card is served by the registry row. */
  host: "run_card" | "page_gate_region";
  /** The run-scoped schedule ref, minted server-side by the page. */
  cardRef: string;
  /** The numeral this row shows — 1, because the schedule step sits above the
   *  run's other steps and above "1 Review" (§7.2 step 5). */
  displayStep: number;
  /** Opened on first paint. The capture walk uses it; a reader gets the
   *  collapsed row and opens it, which is what "open that step" describes. */
  defaultOpen?: boolean;
}): ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const cardView = {
    viewType: "trigger_schedule_proposal" as const,
    schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION,
    ref: cardRef,
  };

  return (
    <div
      data-conformance-id="schedule-rail-step"
      data-schedule-rail-step=""
      data-schedule-rail-host={host}
      data-schedule-rail-open={open ? "true" : "false"}
      className="flex flex-col gap-2"
    >
      {/* The disclosure control is the shadcn <Button>, not a raw <button> —
          the design-system boundary (eslint `no-restricted-syntax`) admits no
          raw control JSX outside the vendored primitives, and the sibling
          control in `ScheduleProposalCard` takes the same shape. `ghost` plus
          the size/hover neutralisers is what keeps a rail ROW looking like a
          rail row rather than a pill: no chrome at rest, no muted fill while
          it is open, and the same `hover:opacity-90` the row had. */}
      <Button
        type="button"
        variant="ghost"
        data-action="open-schedule-step"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="h-auto justify-start gap-2 rounded-control px-0 py-0.5 text-left whitespace-normal hover:bg-transparent hover:opacity-90 aria-expanded:bg-transparent aria-expanded:text-foreground dark:hover:bg-transparent"
      >
        <span
          data-conformance-id="schedule-rail-indicator"
          className="relative flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary text-xs text-primary-foreground"
        >
          {displayStep}
        </span>
        <CalendarClock aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">{SCHEDULE_RAIL_STEP_LABEL}</span>
        {open ? (
          <ChevronDown aria-hidden="true" className="size-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
        )}
      </Button>

      {/* THE CONFIGURATION, AND NOTHING ELSE. The same component the chat
          thread, the widget and the other page mount — the option rows, the
          estimated duration, Save changes, and (because this IS the page's
          schedule step) the two operations Cancel schedule and Run now. There is
          no summary box and no status label above the form: plan (A) §7.2 as
          amended 2026-08-23 — "The schedule step on the run page and the review
          page shows the same form and nothing else — no summary box, no status
          label". The card draws NO DOM at all for a run no proposal produced, so
          an ordinary run shows the row and an empty panel rather than an
          invented one. */}
      {open ? (
        <div
          data-conformance-id="schedule-step-detail"
          className="ms-3 w-[26rem] max-w-[80vw] border-s border-line ps-3"
        >
          {/* THE HOST IS DECLARED BY NAME, ONCE PER PAGE, rather than threaded
              through as `host={host}`. Two readers depend on a LITERAL
              declaration and neither can follow a prop: the one-card gate's R3
              check that a module mounting a card carries a provider, and the
              host-parity ratchet's composition scan, which reads
              `<LifecycleCardSurfaceProvider host="…">` blocks out of production
              sources to see which host really draws which owner. A prop would
              read to both of them as "no host declared", and the card's own
              runtime would then draw nothing at all. Writing the two branches
              out is also the truthful shape: this component serves exactly two
              hosts and says which. */}
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
      ) : null}
    </div>
  );
}
