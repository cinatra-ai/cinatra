"use client";

// ---------------------------------------------------------------------------
// THE RUN SURFACE'S SELECTION — the context and the hook, and nothing else
// (cinatra#3029, epic #3023 W5).
//
// WHY THIS IS ITS OWN MODULE. The frame that PROVIDES the selection —
// `run-surface-rail.tsx` — also carries the two columns and every row component
// drawn in them. A rail row only needs to ask which step is open and whether a
// key can be opened at all; making it import the frame to ask puts the whole
// frame on the importer's module graph.
//
// That is not a hypothetical cost. The shared non-step row,
// `run-step-rail-extra-entry.tsx`, is reachable from four LOCKED routes
// (`/api/mcp`, `/api/a2a`, `/api/llm-bridge`, `/chat`), and when the run's own
// record became a step that opens, that row started reading the selection. Taken
// from the frame module the edge cost +2 reachable first-party modules on each
// of those four routes, MEASURED against a control checkout of the branch's
// parent in one environment; taken from here it costs one.
//
// It is the same split, for the same reason, that the rail's labels
// (`run-surface-rail-labels.ts`) and its step vocabulary and predicates
// (`run-surface-rail-step.ts`) already took: the piece a consumer actually needs
// lives on its own, so the consumer does not drag the frame in behind it.
//
// NOTHING FIRST-PARTY MAY BE IMPORTED HERE AS A VALUE. The step vocabulary comes
// in as a TYPE, which crosses no module graph. Adding a value import would put
// the cost straight back, and
// `__tests__/run-surface-rail-selection-narrowness.test.ts` reds if one appears.
// ---------------------------------------------------------------------------

import { createContext, useContext } from "react";

import type { RunStepSelection } from "./run-surface-rail-step";

export const RunStepSelectionContext = createContext<{
  selected: RunStepSelection;
  select: (next: RunStepSelection) => void;
  /**
   * Does THIS frame carry a step under that key, with something to open?
   *
   * A row drawn beside the frame cannot see the step list, so it used to infer
   * "I open something" from the mere presence of this context — and a frame
   * that carries no such step would then draw a pressable, focusable row that
   * does nothing when pressed (`select` refuses it). The frame is the one
   * authority on selectability (`isRunSurfaceStepSelectable`), so it answers.
   */
  canSelect: (key: RunStepSelection) => boolean;
} | null>(null);

/**
 * The selection, for a rail row drawn by the rail BESIDE this frame.
 *
 * The review page's rail is its own component (`ReviewRunSteps`) and its Review
 * row has to be able to bring the review card back into the run detail after a
 * gate step was opened — "selecting a step opens it on the right" is the rail's
 * property, not any one row's. `null` when there is no gate step on the page at
 * all, which is how a rail keeps its inert shape unchanged for a run that has
 * none.
 */
export function useRunStepSelection() {
  return useContext(RunStepSelectionContext);
}
