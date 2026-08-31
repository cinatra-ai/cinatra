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
  RUN_SURFACE_RAIL_ROW_CLOSED_CLASS,
  RunSurfaceRailStepGlyph,
  runSurfaceRailIndicatorClass,
  runSurfaceRailTitleClass,
  useRunStepSelection,
} from "./run-surface-rail";
import { RUN_SURFACE_RAIL_LABELS } from "./run-surface-rail-labels";

/**
 * The label the rail row carries — READ FROM THE RAIL'S OWN VOCABULARY rather
 * than authored a second time here (cinatra#3047, review point A).
 *
 * The word is "Skills": the step is the run's skill list with a checkbox each,
 * and the rail names what the step shows. It used to be authored twice — this
 * constant and RUN_SURFACE_RAIL_LABELS.recommendation — which is two places for
 * one word and one of them for a rename to miss. There is one now, and the
 * rail's other labels are untouched by it.
 */
export const RECOMMENDATION_RAIL_STEP_LABEL = RUN_SURFACE_RAIL_LABELS.recommendation;

export function RecommendationRailStepRow({
  settled,
  openable = true,
}: {
  /** Has the question been decided? A decided row is the rail's read-only
   *  history row; a live one is the step the run is paused on. */
  settled: boolean;
  /**
   * CAN THIS ROW BE OPENED (cinatra#3047, convergence)?
   *
   * The rail's own rule, written on its generic row: "A row that cannot be
   * opened is handed the name of THAT state instead, so a walk (or a suite)
   * selecting `open-<key>-step` finds no element it cannot actually press." This
   * row named `open-recommendation-step` unconditionally and carried a click
   * handler with it, while the FRAME refuses a selection onto a step that opens
   * onto nothing — so on a page whose Skills step is closed (the TTL sweeper's
   * fail-closed park nobody answered) the row advertised an affordance that did
   * nothing, and a capture walk graded against `data-action` measured a press it
   * could never take. Closed is the exception rather than the rule, so it
   * defaults to open and the one page that can close it says so.
   */
  openable?: boolean;
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
      // The same two names the rail's generic row uses, so one walk reads one
      // vocabulary on every row of the rail.
      data-action={openable ? "open-recommendation-step" : "recommendation-step-unavailable"}
      aria-current={selected ? "step" : undefined}
      // `aria-disabled`, never the native `disabled`: the row stays on the rail
      // and in the tab order — the series is the run's — and announces itself as
      // unavailable when focus arrives (cinatra#2970).
      aria-disabled={openable ? undefined : "true"}
      onClick={openable ? () => selection?.select("recommendation") : undefined}
      className={openable ? RUN_SURFACE_RAIL_ROW_CLASS : RUN_SURFACE_RAIL_ROW_CLOSED_CLASS}
    >
      <span
        data-conformance-id="recommendation-rail-indicator"
        className={runSurfaceRailIndicatorClass(selected || settled)}
      >
        {/* A GLYPH ON EITHER READING, NEVER A NUMERAL (cinatra#3047, the
            re-shoot's third defect). The drawing gives this entry its own
            clipboard-check glyph while the question is open and the rail's
            ordinary completed circle once it is answered, and it numbers the
            WORK steps from 1 under both. The row used to take a `displayStep`
            and draw it, which is what put "1" on the pending Skills row and
            pushed the run's first work step to "2"; the prop is gone rather
            than ignored, so no caller can hand this row a numeral again. */}
        {settled ? <Check className="h-3 w-3" /> : <RunSurfaceRailStepGlyph />}
      </span>
      <span className={runSurfaceRailTitleClass(selected)}>
        {RECOMMENDATION_RAIL_STEP_LABEL}
      </span>
    </Button>
  );
}
