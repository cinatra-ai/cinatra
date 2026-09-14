"use client";

// ---------------------------------------------------------------------------
// Run step rail — wrapped-row geometry fixture (cinatra#2840; re-pointed at the
// wrapping NAME by cinatra#3149, fix leg 4).
//
// Mounts the REAL `RunStepRailPanel` (the rail the run detail draws) with a
// deterministic entry set, so the row-box geometry of a row whose text wraps is
// verifiable in a browser without a run, a session or a DB round-trip (same
// convention as the agents-card / marketplace-detail-modal fixtures).
//
// The reported defect: a rail row whose text was long enough to wrap printed on
// top of the rows beneath it. Geometry is the whole claim, so it cannot be
// proven in jsdom — the assertions live in
// tests/e2e/design/run-step-rail-geometry.spec.ts and read real bounding boxes
// off this route.
//
// WHAT WRAPS, AND WHY IT CHANGED. #2840 reported the defect on a lifecycle
// POLICY REASON, which the rail drew as a second line beneath the entry's name.
// The ratified drawing gives a rail entry a glyph and ONE name and no reason at
// all, so leg 4 of cinatra#3149 removed that second line — and with it the only
// text this fixture had to wrap. The row geometry it pins is not about the
// reason, though: it is about ANY row whose text runs past the rail's fixed
// column, and the rail's own names do exactly that (cinatra#3226 — "the row
// spans the rail column and may SHRINK inside it, which is what lets a long
// label wrap instead of running past the column"). So the wrapping subject is
// now the entry's NAME, which is the text the rail actually draws.
//
// Three rails, side by side:
//   • run-step-rail-wrapped — the reported scenario: TWO CONSECUTIVE steps
//     named by the work they did at the length a real milestone reaches, long
//     enough to wrap to several lines inside the narrow rail, sandwiched
//     between ordinary single-line step rows so the push-down is measurable.
//   • run-step-rail-single-line — a settled lifecycle row whose name is SHORT
//     enough not to wrap, between two ordinary step rows: the case where the
//     row's alignment could go wrong with no wrapping to make it obvious.
//   • run-step-rail-plain — the same rail with no lifecycle rows at all: the
//     control that pins "ordinary rows are unchanged".
//
// Kept OFF the pixel-diffed /design-fixtures index page so the committed
// baselines there stay untouched; the coverage for this route is assertion-based.
// ---------------------------------------------------------------------------

import {
  RunStepRailPanel,
  type RunStepRailEntry,
} from "@cinatra-ai/agents/run-step-rail-panel";

// The rail names an entry by the work it did, and a real milestone name runs
// this long. Long enough to wrap to several lines inside the rail's narrow
// column at every viewport the spec samples.
const LONG_WORK_NAME =
  "Drafted the re-engagement email for the Q3 cohort and its featured image";

const SECOND_LONG_WORK_NAME =
  "Collected every published migrations post the cohort had already opened this quarter";

// The SHORT counterpart: the name the projection gives a settled policy
// decision, which fits on ONE line inside the rail at every viewport the spec
// samples. This is the row the wrapped fixtures cannot exercise — a row with
// nothing to wrap leaves no overlap behind to notice.
const SINGLE_LINE_NAME = "Review skipped";

function step(ordinal: number, label: string, status: RunStepRailEntry["status"]): RunStepRailEntry {
  return {
    key: `step-${ordinal}`,
    ordinal,
    kind: "step",
    label,
    status,
    sources: ["template"],
  };
}

function skippedLifecycle(ordinal: number, label: string): RunStepRailEntry {
  return {
    key: `lifecycle-${ordinal}`,
    ordinal,
    kind: "lifecycleDecision",
    label,
    status: "skipped",
    sources: ["lifecycleDecision"],
    lifecycleDecision: {
      eventId: `evt-${ordinal}`,
      artifactId: `artifact-${ordinal}`,
      outcome: "skipped",
      decidedBy: "org-bound",
      latticeOutcome: "skip",
      reason: "the org policy skips review for outreach drafts",
    },
  };
}

// The reported rail: two consecutive rows carrying multi-line names, with an
// ordinary step row after them so a row that fails to grow is caught by the row
// BELOW it, not only by its own box.
const WRAPPED_ENTRIES: RunStepRailEntry[] = [
  step(1, "Collect sources", "completed"),
  step(2, "Draft the change", "completed"),
  step(3, LONG_WORK_NAME, "completed"),
  step(4, SECOND_LONG_WORK_NAME, "completed"),
  step(5, "Publish", "upcoming"),
];

// The single-line rail: ONE settled lifecycle row whose name does not wrap,
// with ordinary step rows on both sides so its alignment can be read against a
// row that has always been a plain single-line row.
const SINGLE_LINE_ENTRIES: RunStepRailEntry[] = [
  step(1, "Collect sources", "completed"),
  skippedLifecycle(2, SINGLE_LINE_NAME),
  step(3, "Publish", "upcoming"),
];

// The control rail: identical step rows, no lifecycle rows at all.
const PLAIN_ENTRIES: RunStepRailEntry[] = [
  step(1, "Collect sources", "completed"),
  step(2, "Draft the change", "completed"),
  step(3, "Publish", "upcoming"),
];

export function RunStepRailGeometryFixtures() {
  return (
    <div className="flex flex-row items-start gap-16">
      <div data-surface-id="run-step-rail-wrapped">
        <RunStepRailPanel
          entries={WRAPPED_ENTRIES}
          activeOrdinal={null}
          reviewHrefBase="/design-fixtures/run-step-rail/review"
        />
      </div>
      <div data-surface-id="run-step-rail-single-line">
        <RunStepRailPanel
          entries={SINGLE_LINE_ENTRIES}
          activeOrdinal={null}
          reviewHrefBase="/design-fixtures/run-step-rail/review"
        />
      </div>
      <div data-surface-id="run-step-rail-plain">
        <RunStepRailPanel
          entries={PLAIN_ENTRIES}
          activeOrdinal={null}
          reviewHrefBase="/design-fixtures/run-step-rail/review"
        />
      </div>
    </div>
  );
}
