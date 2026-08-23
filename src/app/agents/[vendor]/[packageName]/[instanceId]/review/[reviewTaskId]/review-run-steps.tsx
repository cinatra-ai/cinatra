"use client";

import { Check } from "lucide-react";

import { ScheduleRailStep } from "@cinatra-ai/agents/schedule-rail-step";
import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperNav,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from "@/components/reui/stepper";

/**
 * The agent-run STEP list on the LEFT of the review surface (owner ruling
 * 2026-07-25 (2), cinatra#2063: the agent run steps must show on the left as run
 * context). A read-only vertical stepper built from the SAME reui Stepper
 * primitives the live run-detail panel uses (no new design tokens) — the run's
 * HITL steps completed, then the current REVIEW step highlighted as active. It is
 * inert: no streaming, no click targets, no dev-preview/replay affordances — the
 * live panel owns those; here the steps are pure context for the decision on the
 * right.
 *
 * THE SCHEDULE STEP SITS ABOVE THEM ALL (cinatra#2788, epic #2784 S9d). Plan
 * (A) §7.2 step 5: "On the run page and the review page the schedule is a
 * **dedicated step in the step rail on the left, above '1 Review'**: open that
 * step to see the configuration or change it. The schedule is never drawn as a
 * card among the review cards." So when the run carries a schedule this rail
 * draws it as step 1 and renumbers itself around it — the Review step that used
 * to read "1 Review" reads "2 Review" — and the gate region beside it holds the
 * review card alone. `stepOffset` is that renumbering, applied to BOTH the
 * item's own step value and the stepper's active value so the completed/active
 * states are unchanged by it.
 */
export type ReviewRunStep = { index: number; label: string };

export function ReviewRunSteps({
  steps,
  activeStep,
  scheduleCardRef = null,
}: {
  steps: ReviewRunStep[];
  activeStep: number;
  /** The run-scoped schedule ref, minted by the page. `null` for a run with no
   *  schedule — which draws no schedule step at all rather than an empty one. */
  scheduleCardRef?: string | null;
}) {
  const offset = scheduleCardRef ? 1 : 0;
  return (
    <div
      data-review-run-steps=""
      className="flex shrink-0 flex-col gap-2 pt-1"
      aria-label="Agent run steps"
    >
      {scheduleCardRef ? (
        <ScheduleRailStep host="page_gate_region" cardRef={scheduleCardRef} displayStep={1} />
      ) : null}
      <Stepper value={activeStep + offset} orientation="vertical" indicators={{ completed: <Check className="h-3 w-3" /> }}>
        <StepperNav>
          {steps.map((s, i) => {
            const isCompleted = s.index < activeStep;
            const isActive = s.index === activeStep;
            const isLast = i === steps.length - 1;
            return (
              <StepperItem
                key={s.index}
                step={s.index + offset}
                completed={isCompleted}
                disabled={s.index > activeStep}
                className="items-start !flex-none"
              >
                <div className="flex items-center gap-1">
                  <StepperTrigger className="gap-2 px-0 py-0.5" tabIndex={-1}>
                    <StepperIndicator className="data-[state=inactive]:bg-muted-foreground/40 data-[state=inactive]:text-background">
                      {s.index + offset}
                    </StepperIndicator>
                    <StepperTitle
                      className="data-[state=inactive]:text-muted-foreground data-[state=completed]:text-muted-foreground"
                      // The active step is the gated REVIEW step; mark it so the
                      // live proof can anchor "the gated step is highlighted".
                      data-review-gated-step={isActive ? "true" : undefined}
                    >
                      {s.label}
                    </StepperTitle>
                  </StepperTrigger>
                </div>
                {!isLast && <StepperSeparator className="ms-3 !h-2 bg-border" />}
              </StepperItem>
            );
          })}
        </StepperNav>
      </Stepper>
    </div>
  );
}
