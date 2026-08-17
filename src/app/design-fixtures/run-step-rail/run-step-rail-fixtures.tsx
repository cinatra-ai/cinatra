"use client";

// ---------------------------------------------------------------------------
// Run step rail — wrapped-lifecycle-reason row geometry fixture (cinatra#2840).
//
// Mounts the REAL `RunStepRailPanel` (the rail the run detail draws) with a
// deterministic entry set, so the row-box geometry of a WRAPPED policy reason
// is verifiable in a browser without a run, a session or a DB round-trip
// (same convention as the agents-card / marketplace-detail-modal fixtures).
//
// The reported defect: a lifecycle reason long enough to wrap printed on top of
// the rows beneath it. Geometry is the whole claim, so it cannot be proven in
// jsdom — the assertions live in tests/e2e/design/run-step-rail-geometry.spec.ts
// and read real bounding boxes off this route.
//
// Two rails, side by side:
//   • run-step-rail-wrapped — the reported scenario: TWO CONSECUTIVE skipped
//     lifecycle rows whose reasons wrap to several lines inside the narrow
//     rail, sandwiched between ordinary single-line step rows so the push-down
//     is measurable.
//   • run-step-rail-plain — the same rail with NO lifecycle rows: the control
//     that pins "rows without reasons are unchanged".
//
// Kept OFF the pixel-diffed /design-fixtures index page so the committed
// baselines there stay untouched; the coverage for this route is assertion-based.
// ---------------------------------------------------------------------------

import { RunStepRailPanel } from "@cinatra-ai/agents/run-step-rail-panel";
import type { RunStepRailEntry } from "@cinatra-ai/agents/run-step-rail";

// The verbatim shape the decision lattice emits when a policy moved after a
// decision was taken — the string the report was filed against. Long enough to
// wrap to several lines inside the rail's narrow reason column at every
// viewport the spec samples.
const STALE_ORG_REASON =
  "policy has changed since this decision (now: org policy requires review for this class)";

const SECOND_STALE_ORG_REASON =
  "policy has changed since this decision (now: org policy requires review before any published artifact is replaced)";

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

function skippedLifecycle(ordinal: number, label: string, reason: string): RunStepRailEntry {
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
      reason,
    },
  };
}

// The reported rail: two consecutive skipped rows carrying multi-line reasons,
// with an ordinary step row after them so a row that fails to grow is caught by
// the row BELOW it, not only by its own box.
const WRAPPED_ENTRIES: RunStepRailEntry[] = [
  step(1, "Collect sources", "completed"),
  step(2, "Draft the change", "completed"),
  skippedLifecycle(3, "Review skipped", STALE_ORG_REASON),
  skippedLifecycle(4, "Review skipped", SECOND_STALE_ORG_REASON),
  step(5, "Publish", "upcoming"),
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
