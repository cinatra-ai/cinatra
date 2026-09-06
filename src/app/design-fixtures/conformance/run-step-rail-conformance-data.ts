// ---------------------------------------------------------------------------
// The RUN STEP RAIL harness mount's deterministic entry set, and the readings
// that mount stands for (cinatra#3162, epic #3155 W6 — the run step-rail
// family).
//
// A DATA module: no directive, no component, no React import — the Playwright
// driver (tests/e2e/design/conformance/contract.ts) reads these constants, and
// a Playwright module may not pull a client component into its graph. The mount
// itself is the sibling .tsx, exactly as the seeded and lifecycle-card fixtures
// keep their data beside their components.
//
// WHY THE RAIL AND NOT THE WHOLE FRAME. Section I's rail sentences are claims
// about the rail: the order of the rows, a gate drawn inline as a step of the
// run rather than a page outside it, the step the run is paused on highlighted
// with what is passed above it and what is still to come below, and a resolved
// gate keeping its place as read-only history that records how it was settled.
// Every one of those is drawn by `RunStepRailPanel` from these entries alone.
//
// The SELECTION half of section I — "Selecting a step opens it on the right" —
// belongs to the two-column frame, not to this panel: the panel's rows are
// inert, and the frame that turns a row press into an open step is on no
// package subpath a core route may import. That is why this wave asserts the
// rail's drawn claims here and names the surface's one declared action on its
// readiness list instead of pressing a row that does nothing and reporting an
// outcome for it.
//
// FICTIONAL identifiers throughout (the core/extension instance-coupling ban
// forbids a core file naming a real extension instance); the rail renders the
// labels and the dispositions and resolves none of these ids.
// ---------------------------------------------------------------------------

import type { RunStepRailEntry } from "@cinatra-ai/agents/run-step-rail-panel";

/**
 * The rail's rows, in the order section I puts them: the run's ordered steps
 * with its gates woven in AT THE POINT THE RUN REACHED THEM — one gate already
 * answered and kept as history, the gate the run is paused on, and a step still
 * ahead.
 */
export const RUN_STEP_RAIL_CONFORMANCE_ENTRIES: RunStepRailEntry[] = [
  {
    key: "conformance-step-skills",
    ordinal: 1,
    kind: "step",
    label: "Skills",
    status: "completed",
    sources: ["template"],
  },
  {
    key: "conformance-gate-resolved",
    ordinal: 2,
    kind: "gate",
    label: "Review",
    status: "resolved",
    sources: ["gate"],
    gate: {
      gateId: "conformance-gate-1",
      reviewTaskId: "conformance-review-1",
      // "records how it was settled (continued, superseded by a regeneration,
      // changes requested)" — the word the history row carries.
      disposition: "continued",
      // The settled ACT the rail reads to word its settled row. It is derived
      // from the disposition beside it and stated here for the same reason the
      // disposition is: this fixture is the drawing's own reading, not the
      // product's output, so it says what the row must show rather than letting
      // the component infer it.
      settledAct: "continued",
      resolved: true,
    },
  },
  {
    key: "conformance-step-draft",
    ordinal: 3,
    kind: "step",
    label: "Draft the post",
    status: "completed",
    sources: ["template", "stepResult"],
  },
  {
    key: "conformance-gate-pending",
    ordinal: 4,
    kind: "gate",
    label: "Review",
    status: "pending",
    sources: ["gate"],
    gate: {
      gateId: "conformance-gate-2",
      reviewTaskId: "conformance-review-2",
      disposition: null,
      // Nothing has settled this gate, so there is no act to name.
      settledAct: null,
      resolved: false,
    },
  },
  {
    key: "conformance-step-outputs",
    ordinal: 5,
    kind: "step",
    label: "What the run made",
    status: "upcoming",
    sources: ["template"],
  },
];

/**
 * The reading the rail OWES, written out independently of the entries above.
 *
 * Deriving the expected labels from the entries would let the driver assert the
 * fixture back against itself: any rail that echoed its input in any order would
 * pass. These three lists are the wave's own statement of what section I says a
 * reader must see — the labels in the run's order, each row's kind, each row's
 * status — and the wave's unit test
 * (scripts/design/__tests__/conformance-run-step-rail-wave.test.mjs) reconciles
 * them against the entry set, so a fixture edited without the intent goes red in
 * the node tier instead of quietly moving what the browser asserts.
 */
export const RUN_STEP_RAIL_CONFORMANCE_LABELS: readonly string[] = [
  "Skills",
  "Review",
  "Draft the post",
  "Review",
  "What the run made",
];

/** Each drawn row's kind, in the same order — a gate is a STEP of the run. */
export const RUN_STEP_RAIL_CONFORMANCE_ROW_KINDS: readonly string[] = [
  "step",
  "gate",
  "step",
  "gate",
  "step",
];

/** Each drawn row's status, in the same order. */
export const RUN_STEP_RAIL_CONFORMANCE_ROW_STATUSES: readonly string[] = [
  "completed",
  "resolved",
  "completed",
  "pending",
  "upcoming",
];

/** The ordinal of the entry the run is paused on — the rail's active value. */
export const RUN_STEP_RAIL_CONFORMANCE_PAUSED_ORDINAL = 4;

/** Its 1-based POSITION among the drawn rows: what the reader sees highlighted. */
export const RUN_STEP_RAIL_CONFORMANCE_PAUSED_POSITION =
  RUN_STEP_RAIL_CONFORMANCE_ENTRIES.findIndex(
    (entry) => entry.ordinal === RUN_STEP_RAIL_CONFORMANCE_PAUSED_ORDINAL,
  ) + 1;

/** The 1-based position of the answered gate kept on the rail as history. */
export const RUN_STEP_RAIL_CONFORMANCE_SETTLED_POSITION = 2;

/** The disposition that settled row records. */
export const RUN_STEP_RAIL_CONFORMANCE_SETTLED_DISPOSITION = "continued";

/** The 1-based positions of the rows the run has already passed. */
export const RUN_STEP_RAIL_CONFORMANCE_PASSED_POSITIONS = [1, 2, 3];

/** The 1-based positions of the rows still to come. */
export const RUN_STEP_RAIL_CONFORMANCE_UPCOMING_POSITIONS = [5];

/** The 1-based positions of the rows that are GATE entries, not work steps. */
export const RUN_STEP_RAIL_CONFORMANCE_GATE_POSITIONS = [2, 4];
