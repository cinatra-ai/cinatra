"use client";

import Link from "next/link";
import { Check, ClipboardCheck } from "lucide-react";

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
 */
export function RunStepRailPanel({
  entries,
  activeOrdinal,
  reviewHrefBase,
}: {
  entries: RunStepRailEntry[];
  activeOrdinal: number | null;
  reviewHrefBase: string;
}) {
  if (entries.length === 0) return null;
  // The stepper's numeric "value" is the active display index. Map the active
  // ordinal to its 1-based position in the sorted rail; fall back to past-the-end
  // (everything completed) when nothing is active.
  const activeIndex =
    activeOrdinal == null
      ? entries.length + 1
      : Math.max(1, entries.findIndex((e) => e.ordinal === activeOrdinal) + 1);

  return (
    <div
      data-run-step-rail=""
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
            const displayStep = i + 1;
            const isGate = entry.kind === "gate";
            const isResolved = entry.status === "resolved";
            const isPending = entry.status === "pending";
            const isCompleted = entry.status === "completed" || isResolved;
            const isActive = displayStep === activeIndex || isPending;
            const isLast = i === entries.length - 1;

            const titleNode = (
              <StepperTitle
                className="data-[state=inactive]:text-muted-foreground data-[state=completed]:text-muted-foreground"
                data-rail-kind={entry.kind}
                data-rail-status={entry.status}
                // Anchors for the live proof: the active gated step + resolved
                // read-only history are each addressable.
                data-rail-gated-step={isGate ? "true" : undefined}
                data-rail-gate-history={isGate && isResolved ? "true" : undefined}
                data-rail-gate-pending={isGate && isPending ? "true" : undefined}
              >
                {entry.label}
                {isGate && isResolved ? (
                  <span className="ms-1.5 text-badge-2xs uppercase tracking-widest text-muted-foreground">
                    {entry.gate?.disposition ?? "resolved"}
                  </span>
                ) : null}
              </StepperTitle>
            );

            const indicatorNode = (
              <StepperIndicator className="data-[state=inactive]:bg-muted-foreground/40 data-[state=inactive]:text-background">
                {isGate ? <ClipboardCheck className="h-3 w-3" /> : displayStep}
              </StepperIndicator>
            );

            return (
              <StepperItem
                key={entry.key}
                step={displayStep}
                completed={isCompleted}
                disabled={!isGate && entry.status === "upcoming" && !isActive}
                className="items-start !flex-none"
              >
                <div className="flex items-center gap-1">
                  {isGate && entry.gate ? (
                    // A gate row links into the run-embedded review surface. A
                    // resolved gate still links — the review page replays the
                    // completed submission read-only. Rendered as a plain Link
                    // (not a StepperTrigger button) to avoid a button-in-anchor.
                    <Link
                      href={`${reviewHrefBase}/${encodeURIComponent(entry.gate.reviewTaskId)}`}
                      className="flex items-center gap-2 rounded-sm px-0 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      data-rail-gate-link={entry.gate.reviewTaskId}
                    >
                      {indicatorNode}
                      {titleNode}
                    </Link>
                  ) : (
                    <StepperTrigger className="gap-2 px-0 py-0.5" tabIndex={-1}>
                      {indicatorNode}
                      {titleNode}
                    </StepperTrigger>
                  )}
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
