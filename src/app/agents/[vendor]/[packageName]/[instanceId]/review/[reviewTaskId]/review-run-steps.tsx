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

/**
 * The agent-run STEP list on the LEFT of the review surface (owner ruling
 * 2026-07-25 (2), cinatra#2063: the agent run steps must show on the left as run
 * context). A read-only vertical stepper built from the SAME reui Stepper
 * primitives the live run-detail panel uses (no new design tokens) — the run's
 * HITL steps completed, then the current REVIEW step highlighted as active. It is
 * inert: no streaming, no click targets, no dev-preview/replay affordances — the
 * live panel owns those; here the steps are pure context for the decision on the
 * right.
 */
export type ReviewRunStep = { index: number; label: string };

export function ReviewRunSteps({
  steps,
  activeStep,
}: {
  steps: ReviewRunStep[];
  activeStep: number;
}) {
  return (
    <div
      data-review-run-steps=""
      className="flex shrink-0 flex-col pt-1"
      aria-label="Agent run steps"
    >
      <Stepper value={activeStep} orientation="vertical" indicators={{ completed: <Check className="h-3 w-3" /> }}>
        <StepperNav>
          {steps.map((s, i) => {
            const isCompleted = s.index < activeStep;
            const isActive = s.index === activeStep;
            const isLast = i === steps.length - 1;
            return (
              <StepperItem
                key={s.index}
                step={s.index}
                completed={isCompleted}
                disabled={s.index > activeStep}
                className="items-start !flex-none"
              >
                <div className="flex items-center gap-1">
                  <StepperTrigger className="gap-2 px-0 py-0.5" tabIndex={-1}>
                    <StepperIndicator className="data-[state=inactive]:bg-muted-foreground/40 data-[state=inactive]:text-background">
                      {s.index}
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
