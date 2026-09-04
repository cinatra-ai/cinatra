"use client";

import { Check } from "lucide-react";

import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperNav,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from "@/components/reui/stepper";

import type { RunStepRailEntry } from "./run-step-rail";
import {
  RailExtraEntry,
  RUN_PAGE_RAIL_INDICATOR_CLASS,
  RUN_PAGE_RAIL_ROW_CLASS,
  RUN_PAGE_RAIL_SEP_CLASS,
} from "./run-step-rail-extra-entry";
import { useRunStepSelection } from "./run-surface-rail";

// The panel's own entry type, re-exported so a caller mounting this component
// through the `./run-step-rail-panel` subpath can TYPE the entries it passes
// without the package having to open a SECOND subpath onto the rail's domain
// module (`./run-step-rail`, which also carries `buildRunStepRail` and the
// whole builder input surface). One export per mountable component; the
// builder stays internal (cinatra#2840, codex advisory).
export type { RunStepRailEntry } from "./run-step-rail";

/**
 * The canonical run view's LEFT STEP RAIL (cinatra#2066, C1; owner ruling
 * 2026-07-25). ONE vertical rail for BOTH template classes — orchestrator-template
 * runs and single-agent/transcript runs — rendered from the merged step list
 * (`buildRunStepRail`): template-derived steps + submissions, transcript turns,
 * stepResults, with the run's review GATES woven in, INCLUDING resolved ones as
 * read-only history.
 *
 * Built from the SAME reui Stepper primitives the review surface's minimal rail
 * (`ReviewRunSteps`, cinatra#2061) uses — no new design tokens. A gate entry
 * DEEP-LINKS into the relocated review surface
 * (`/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]`): a pending
 * gate is the active decision; a resolved gate replays read-only. Non-gate steps
 * are inert context (the right pane owns streaming/replay).
 *
 * WHERE IT MOUNTS, AFTER cinatra#2739. This panel is the run detail's rail on
 * the branches where the right pane draws NO rail of its own — the agentic /
 * transcript panel, and a stepper panel with no policy steps. On the
 * flow/orchestrator branch the LIVE rail inside `OrchestratorStepperPanel`
 * (`StepperColumn`) is the one rail, and this panel stands down: the two used to
 * mount together and drew the same five steps twice, side by side. The screen
 * decides through `screenHostsStepRail`; the review deep links are the SAME
 * component on both (`RailExtraEntry`).
 */
export function RunStepRailPanel({
  entries,
  activeOrdinal,
  reviewHrefBase,
  stepOffset = 0,
}: {
  entries: RunStepRailEntry[];
  activeOrdinal: number | null;
  reviewHrefBase: string;
  /**
   * How many rows this rail is renumbered by (cinatra#2788, S9d).
   *
   * The SCHEDULE STEP sits above the run's other steps — plan (A) §7.2 step 5,
   * "a **dedicated step in the step rail on the left, above '1 Review'**" — and
   * it is drawn by the screen rather than by this panel, because the same row
   * has to head the review page's rail too. So the screen tells this rail how
   * far to shift its numerals; `1` makes the row that read "1 Review" read
   * "2 Review". The shift is applied to the item's step value AND the stepper's
   * active value together, so nothing about completed/active changes with it.
   */
  stepOffset?: number;
}) {
  // "Selecting a step opens it on the right. A WORK STEP shows what it did"
  // (the ratified drawing). The run detail IS that reading, so a work step's row
  // returns the detail to it — which is also how a reader leaves the record's
  // own page now that the record opens alone. `null` outside the run-surface
  // frame, where there is no selection to change and the rows stay inert.
  const selection = useRunStepSelection();
  if (entries.length === 0) return null;
  // The stepper's numeric "value" is the active display index. Map the active
  // ordinal to its 1-based position in the sorted rail; fall back to past-the-end
  // (everything completed) when nothing is active.
  const activeIndex =
    (activeOrdinal == null
      ? entries.length + 1
      : Math.max(1, entries.findIndex((e) => e.ordinal === activeOrdinal) + 1)) + stepOffset;

  return (
    <div
      data-run-step-rail=""
      data-conformance-id="run-step-rail"
      data-action="open-run-step -> step-detail"
      className="flex w-52 shrink-0 flex-col pt-1"
      aria-label="Agent run steps"
    >
      <Stepper
        value={activeIndex}
        orientation="vertical"
        indicators={{ completed: <Check className="h-3 w-3" /> }}
      >
        <StepperNav>
          {entries.map((entry, i) => {
            const displayStep = i + 1 + stepOffset;
            const isResolved = entry.status === "resolved";
            const isSkipped = entry.status === "skipped";
            const isPending = entry.status === "pending";
            const isCompleted = entry.status === "completed" || isResolved;
            const isActive = displayStep === activeIndex || (isPending && entry.kind !== "lifecycleDecision");
            const isLast = i === entries.length - 1;
            // THE CURRENT-POSITION MARKER (cinatra#3149 item 3). The ratified
            // drawing on the review step: "The run waits at each — ONE ENTRY IS
            // HIGHLIGHTED AT A TIME". So the marker is written from the rail's
            // OWN anchor, `activeIndex` — the single index the stepper is on —
            // and never from `isActive`, which is deliberately looser (it also
            // opens every pending row) and would mark several rows at once.
            //
            // SCOPED TO THE DETAIL. Every row this panel draws opens the run
            // DETAIL. When the reader has opened another page of the frame —
            // the run's own record, a step of its own — that page's row is the
            // current one and carries the marker itself
            // (`run-step-rail-extra-entry.tsx`), so this panel stands down and
            // the rail never carries two markers. Outside the frame there is no
            // open page at all, and nothing is marked.
            const isCurrent = selection?.selected === "detail" && displayStep === activeIndex;

            // Gates / verifications / lifecycle decisions render through the
            // SHARED row (cinatra#2739) — the same rows the live rail inside
            // OrchestratorStepperPanel draws, so the review deep links have one
            // implementation. `disabled` was already unreachable for these
            // kinds (the predicate below excludes all three).
            if (entry.kind !== "step") {
              return (
                <StepperItem
                  key={entry.key}
                  step={displayStep}
                  completed={isCompleted}
                  data-rail-skipped={isSkipped ? "true" : undefined}
                  className="items-start !flex-none"
                >
                  <RailExtraEntry
                    entry={entry}
                    reviewHrefBase={reviewHrefBase}
                    displayStep={displayStep}
                    current={isCurrent}
                  />
                  {!isLast && <StepperSeparator className={RUN_PAGE_RAIL_SEP_CLASS} />}
                </StepperItem>
              );
            }

            const titleNode = (
              <StepperTitle className="data-[state=inactive]:text-muted-foreground data-[state=completed]:text-muted-foreground">
                {entry.label}
              </StepperTitle>
            );

            const indicatorNode = (
              <StepperIndicator className={RUN_PAGE_RAIL_INDICATOR_CLASS}>
                {displayStep}
              </StepperIndicator>
            );

            return (
              <StepperItem
                key={entry.key}
                step={displayStep}
                completed={isCompleted}
                disabled={entry.status === "upcoming" && !isActive}
                data-rail-skipped={isSkipped ? "true" : undefined}
                className="items-start !flex-none"
              >
                {/* The rail ANCHORS live on this wrapper, not on StepperTitle:
                    the reui StepperTitle accepts only {children, className} and
                    drops every other prop, so a data-* attribute placed there
                    never reaches the DOM. */}
                <div
                  className="flex items-center gap-1"
                  data-rail-kind={entry.kind}
                  data-rail-status={entry.status}
                >
                  <StepperTrigger
                    className={RUN_PAGE_RAIL_ROW_CLASS}
                    // The marker sits on the ROW, the same place the three
                    // sibling rails on this surface put theirs.
                    aria-current={isCurrent ? "step" : undefined}
                    // EXPLICIT 0, for the reason the record's row states: a
                    // finished rail has no stepper-selected row, so `undefined`
                    // left every row at `-1` and a keyboard reader who landed on
                    // the record's page had no way back to the run's reading.
                    tabIndex={selection ? 0 : -1}
                    data-action={selection ? "open-run-step -> step-detail" : undefined}
                    onClick={selection ? () => selection.select("detail") : undefined}
                    // Enter and Space, on key-UP — `StepperTrigger` swallows the
                    // native activation on key-down. See the record's row.
                    onKeyUp={
                      selection
                        ? (event) => {
                            if (event.key !== "Enter" && event.key !== " ") return;
                            event.preventDefault();
                            selection.select("detail");
                          }
                        : undefined
                    }
                  >
                    {indicatorNode}
                    {titleNode}
                  </StepperTrigger>
                </div>
                {!isLast && <StepperSeparator className={RUN_PAGE_RAIL_SEP_CLASS} />}
              </StepperItem>
            );
          })}
        </StepperNav>
      </Stepper>
    </div>
  );
}
