"use client";

// ---------------------------------------------------------------------------
// The RUN STEP RAIL harness mount (cinatra#3162, epic #3155 W6).
//
// Mounts the REAL `RunStepRailPanel` — the rail the run detail draws — on the
// deterministic entry set in the sibling data module, so section I's claims
// about the rail are assertable in a browser with no run, no session and no
// database round-trip. Same convention as the sibling conformance fixtures and
// as the rail's own geometry fixture (src/app/design-fixtures/run-step-rail/).
//
// Kept OFF the pixel-diffed /design-fixtures index page so the committed
// baselines there stay untouched; coverage here is assertion-based.
// ---------------------------------------------------------------------------

import { RunStepRailPanel } from "@cinatra-ai/agents/run-step-rail-panel";

import {
  RUN_STEP_RAIL_CONFORMANCE_ENTRIES,
  RUN_STEP_RAIL_CONFORMANCE_PAUSED_ORDINAL,
} from "./run-step-rail-conformance-data";

export function RunStepRailConformanceFixture() {
  return (
    <div data-surface-id="run-step-rail">
      <RunStepRailPanel
        entries={RUN_STEP_RAIL_CONFORMANCE_ENTRIES}
        activeOrdinal={RUN_STEP_RAIL_CONFORMANCE_PAUSED_ORDINAL}
        reviewHrefBase="/design-fixtures/conformance/review"
      />
    </div>
  );
}
