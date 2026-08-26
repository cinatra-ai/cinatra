"use client";

// ---------------------------------------------------------------------------
// THE RECOMMENDATION STEP OF THE RUN SURFACE (cinatra#2790, epic #2784 S9f).
//
// Plan: PLAN: Agents Lifecycle (A) §6.2 — "On the run page the same row sits at
// the trigger position, the top entry on the step rail, ahead of the work steps
// it would authorize."
//
// The ratified drawing (`design-run-surface-rail-and-gate.png`): "a gate step
// opens the gate's own surface in place … right here in the run detail, under
// the same rail, never as a standalone document."
//
// WHAT THIS FILE IS. The recommendation's rail ROW, and only the row. Its
// surface is the ONE renderer of this kind — `RecommendationHoldCard` — which
// the screen already mounts under its own `run_card` declaration; the row hands
// the frame that same mount rather than making a second one, so the chip row the
// step opens is the chip row the run page draws.
//
// THE SETTLED READING IS THE RAIL'S OWN, NOT A NEW ONE. Once the question is
// decided the row is a resolved-gate history row — the reading the rail already
// gives every resolved gate it weaves in ("INCLUDING resolved ones as read-only
// history", `RunStepRailPanel`): the completed circle in place of the numeral,
// the title unhighlighted. No status word is added beside it, because the
// drawing shows none.
// ---------------------------------------------------------------------------

import { Check } from "lucide-react";
import type { ReactElement } from "react";

import { Button } from "@/components/ui/button";

import {
  RUN_SURFACE_RAIL_ROW_CLASS,
  runSurfaceRailIndicatorClass,
  runSurfaceRailTitleClass,
  useRunStepSelection,
} from "./run-surface-rail";

/** The label the rail row carries — the plan's own word for this step. */
export const RECOMMENDATION_RAIL_STEP_LABEL = "Recommendation";

export function RecommendationRailStepRow({
  displayStep,
  settled,
}: {
  /** The numeral this row shows while the question is open — 1, the trigger
   *  position, ahead of the work steps it would authorize (§6.2). */
  displayStep: number;
  /** Has the question been decided? A decided row is the rail's read-only
   *  history row; a live one is the step the run is paused on. */
  settled: boolean;
}): ReactElement {
  const selection = useRunStepSelection();
  const selected = selection?.selected === "recommendation";

  return (
    <Button
      type="button"
      variant="ghost"
      data-conformance-id="recommendation-rail-step"
      data-recommendation-rail-step=""
      data-recommendation-step-selected={selected ? "true" : "false"}
      data-recommendation-step-settled={settled ? "true" : "false"}
      data-action="open-recommendation-step"
      aria-current={selected ? "step" : undefined}
      onClick={() => selection?.select("recommendation")}
      className={RUN_SURFACE_RAIL_ROW_CLASS}
    >
      <span
        data-conformance-id="recommendation-rail-indicator"
        className={runSurfaceRailIndicatorClass(selected || settled)}
      >
        {settled ? <Check className="h-3 w-3" /> : displayStep}
      </span>
      <span className={runSurfaceRailTitleClass(selected)}>
        {RECOMMENDATION_RAIL_STEP_LABEL}
      </span>
    </Button>
  );
}
