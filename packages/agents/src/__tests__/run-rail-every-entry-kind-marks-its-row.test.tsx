// @vitest-environment jsdom
/**
 * EVERY KIND OF RAIL ENTRY MARKS ITS STATE ON ITS OWN ROW (cinatra#3449).
 *
 * THE FAILURE THIS FILE EXISTS TO END. Three fix legs ran on the run rail's
 * state marks and each one repaired only the entries the preceding picture
 * round had named: the round after each leg found one more kind of entry drawn
 * with no mark at all. The rail is composed from two sources — the frame's own
 * rows (`run-surface-rail.tsx`, whose `RunSurfaceRailRow` carries the marks)
 * and the entries whose caller supplies its own row, which the frame does not
 * decorate ("the rail decorates only its generic rows on the way through",
 * `instance-screens.tsx`) — so a new kind of row arrives unmarked by default
 * and nothing in the suite says so.
 *
 * THE SHAPE, AND THE POINT OF IT. One table, one row per KIND the rail can
 * draw, iterated once. Each row renders that kind through the component that
 * draws it in the product and asserts, for that one entry:
 *
 *   1. exactly ONE node in the entry's subtree matches
 *      `[data-run-surface-rail-step]` — never the wrapper and the row counted
 *      as two;
 *   2. that node IS the entry's row box — element identity, and the row box
 *      found WITHOUT reading any `data-run-surface-rail-*` attribute. THE
 *      READING THIS REPLACES WAS CIRCULAR: it found the row BY the mark and
 *      then asked only whether that same node's class list contained the
 *      shared row class, so the marked node answered for both sides and a
 *      mark sitting on a node that is not the entry's row could not fail it.
 *      TWO SEPARATE GAPS, NAMED APART so the record stays exact: at the head
 *      the mark DID sit on the row box for every kind (the census read it so),
 *      and what this file could not see is the row box's own SPAN — it read no
 *      ancestor and asserted no width, which is why the third picture round
 *      measured two review entries' rows at 137px inside a 208px rail column
 *      while this file stayed green; the circularity above is the OTHER gap,
 *      the one that would have let a later leg move a mark off its row
 *      unnoticed. The identity reading closes the second, the span assertion
 *      below closes the first. The row box is now found FIRST, from the rail's own
 *      row anchors (the rhythm suite's candidate union with its mark member
 *      dropped, the inert row's anchor added, and the frame row's own control
 *      anchor standing in for the dropped member), narrowed to the node
 *      carrying every token of the shared row class the kind draws
 *      (`RUN_SURFACE_RAIL_ROW_CLASS` for a frame row,
 *      `RUN_PAGE_RAIL_ROW_CLASS` for a page-rail row), and the mark is then
 *      asked to BE it;
 *   3. it carries `data-run-surface-rail-reached` and
 *      `-settled` with the values the kind's own `RailStatus` vocabulary gives
 *      it (`run-step-rail.ts`, derived as
 *      `run-step-rail-extra-entry.tsx` derives them), and
 *      `-selected` PRESENT — "true" or "false", never absent, so a reading of
 *      a drawn entry never receives null for a state mark.
 *
 * And LAST, that the table's kind list equals the rail's kind vocabulary READ
 * FROM THE TYPES rather than restated here: `RunStepRailEntry["kind"]` plus the
 * `RunSurfaceRailStepKey` list the frame draws. A kind added to the rail later
 * and left out of this table fails that assertion — so a kind that loses its
 * marks fails IN THE SUITE, never first in a picture round.
 *
 * `data-run-surface-rail-step-key` is NOT required of every kind: the key names
 * a `RunStepSelection` the frame can open (`run-surface-rail.tsx`), and a page
 * rail entry is not a frame selection, so it carries none BY DESIGN and this
 * file asserts its absence rather than inventing one.
 *
 * AND THE ROW BOX SPANS THE RAIL COLUMN. jsdom lays nothing out, so this file
 * MEASURES NO WIDTH anywhere: it reads the CLASS that makes the width resolve —
 * the run page rail's own vertical nav states the full width of the column it
 * is drawn in, so the widths already declared on the entry wrapper and on the
 * row-class node resolve against that column instead of against a shrink-wrapped
 * inline-flex nav. The two widths themselves — the marked node's and the
 * independently-read row box's — are measured on a real finished run by the
 * later picture round, never here.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-rail-every-entry-kind-marks-its-row.test.tsx
 */
import React from "react";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// The rail's rows draw the design system's icons; the panel mount below pulls
// the whole run surface with them. Stubbed to nothing — this file reads
// attributes, never glyphs — and restored in `afterEach` so the package's full
// run is unchanged by this file's presence.
vi.mock("lucide-react", () => {
  const StubIcon: React.FC = () => null;
  return new Proxy({} as Record<string, React.FC>, {
    get: (_target, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["Check", "Info", "Pause", "default"],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});

vi.mock("@/lib/cinatra-toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("../orchestrator-actions", () => ({
  cancelOrchestratorAction: vi.fn(async () => ({ ok: true })),
  resumeStoppedOrchestratorAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../run-actions", () => ({
  startDevChildPreviewRun: vi.fn(async () => ({ ok: false })),
  buildSubmissionMapByStepIndex: vi.fn(async () => []),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  readRunOutputEvidence: vi.fn(async () => ({
    ok: true,
    outputs: [],
    hasTranscript: false,
    hasStepResults: false,
  })),
}));

vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: vi.fn(async () => ({ state: "none" })),
  decideRunRecommendationAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../run-name-actions", () => ({
  ensureOrCheckRunNameAction: vi.fn(async () => ({ ok: true, title: "Run 1" })),
}));

vi.mock("../hitl-actions", () => ({ approveReviewTask: vi.fn(async () => ({ ok: true })) }));

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: (_runId: string, opts: { initialStatus?: string }) => ({
    status: opts?.initialStatus ?? "completed",
    interruptContext: null,
    messages: [],
    streamedText: "",
    presentationHint: null,
    dataPartFrames: [],
    error: null,
  }),
}));

vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));

import { Stepper, StepperItem, StepperNav } from "@/components/reui/stepper";

import { ScheduleRailStepRow } from "../schedule-rail-step";
import { RecommendationRailStepRow } from "../recommendation-rail-step";
import {
  RUN_SURFACE_RAIL_ROW_CLASS,
  RUN_SURFACE_RAIL_ROW_CLOSED_CLASS,
  RunSurfaceRailRow,
} from "../run-surface-rail";
import {
  RUN_PAGE_RAIL_ROW_CLASS,
  RailExtraEntry,
  RunStepSelectionProvider,
} from "../run-step-rail-extra-entry";
import { RunStepRailPanel } from "../run-step-rail-panel";
import type { RunStepRailEntry } from "../run-step-rail";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// The table's shape.
// ---------------------------------------------------------------------------
type Mark = "true" | "false";

type EntryKind = {
  /** The vocabulary member this kind belongs to, as the last assertion reads
   *  it: `frame:<RunSurfaceRailStepKey>` for a row the frame can open,
   *  `panel:<RunStepRailEntry["kind"]>` for a page-rail entry, and `spine:step`
   *  for the second mount's own step row — which is neither, because it is
   *  drawn from the page's step list rather than from a rail entry. */
  id: string;
  /** The census's own name for this kind. */
  name: string;
  /** The file:line that renders it. */
  where: string;
  /** The shared row class this kind draws — the node the marks must sit on. */
  rowClass: string;
  /** The values the kind's own status vocabulary gives it. */
  reached: Mark;
  settled: Mark;
  selected: Mark;
  /** The frame selection this row opens, or null for an entry that is not one. */
  stepKey: string | null;
  /** Renders the one entry and returns the node that STANDS FOR it — the
   *  subtree the marks are counted in. */
  mount: () => Promise<HTMLElement>;
};

function only(container: HTMLElement, selector: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(selector);
  expect(found, `the render draws ${selector}`).not.toBeNull();
  return found!;
}

/** A page-rail entry's own wrapper is the node that stands for the entry. */
function entryWrapper(container: HTMLElement): HTMLElement {
  return only(container, "[data-rail-kind]");
}

function panelEntry(entry: RunStepRailEntry): HTMLElement {
  const { container } = render(
    <RunStepRailPanel entries={[entry]} activeOrdinal={null} reviewHrefBase="/agents/v/p/run/review" />,
  );
  return entryWrapper(container);
}

function extraEntry(entry: RunStepRailEntry, selected: string | null = null): HTMLElement {
  // THE WRAPPER THE PRODUCT DRAWS AROUND IT, and the reason it is here: both
  // mounts render this component inside a `StepperItem` of a vertical
  // `Stepper` (run-step-rail-panel.tsx:129-156,
  // orchestrator-stepper-panel.tsx:1403-1425) and the row reads that item's
  // context for its own state. The entry drawn outside one is not the entry the
  // product draws.
  const node = (
    <Stepper value={1} orientation="vertical">
      <StepperNav>
        <StepperItem
          step={1}
          completed={entry.status === "completed" || entry.status === "resolved"}
        >
          <RailExtraEntry entry={entry} reviewHrefBase="/agents/v/p/run/review" displayStep={1} />
        </StepperItem>
      </StepperNav>
    </Stepper>
  );
  const { container } = render(
    selected === null ? (
      node
    ) : (
      <RunStepSelectionProvider value={{ selected: selected as never, select: () => {} }}>
        {node}
      </RunStepSelectionProvider>
    ),
  );
  return entryWrapper(container);
}

function frameRow(element: React.ReactElement, selected: string | null = null): HTMLElement {
  const { container } = render(
    selected === null ? (
      element
    ) : (
      <RunStepSelectionProvider value={{ selected: selected as never, select: () => {} }}>
        {element}
      </RunStepSelectionProvider>
    ),
  );
  // One entry is rendered, so the render's own root IS that entry's subtree.
  return container;
}

const step = (over: Partial<RunStepRailEntry>): RunStepRailEntry =>
  ({
    key: "step:1",
    ordinal: 1,
    kind: "step",
    label: "Fetched Q3 cohort",
    status: "completed",
    sources: [],
    ...over,
  }) as RunStepRailEntry;

// ---------------------------------------------------------------------------
// THE TABLE — one row per kind of entry the run rail can draw (cinatra#3449).
// ---------------------------------------------------------------------------
const KINDS: EntryKind[] = [
  {
    id: "frame:schedule",
    name: "the Schedule entry of a run that carries a schedule",
    where: "packages/agents/src/schedule-rail-step.tsx:98",
    rowClass: RUN_SURFACE_RAIL_ROW_CLASS,
    // The schedule is how the run was dispatched, so the run has been through
    // it (instance-screens.tsx, the schedule rail step's own `reached: true`).
    reached: "true",
    settled: "true",
    selected: "true",
    // NO SELECTION KEY, and that is the contract rather than an omission: the
    // key names a `RunStepSelection` the FRAME's own generic row opens
    // (run-surface-rail.tsx:333-334), and this leg adds no selection key to any
    // drawn node. A row its caller supplies is addressed by its own anchors.
    stepKey: null,
    mount: async () =>
      frameRow(<ScheduleRailStepRow host="run_card" displayStep={1} settled />, "schedule"),
  },
  {
    id: "frame:schedule",
    name: "the Schedule entry of a run parked on a schedule it has no card for",
    where: "packages/agents/src/instance-screens.tsx:2517-2542 through RunSurfaceRailRow",
    rowClass: RUN_SURFACE_RAIL_ROW_CLASS,
    reached: "true",
    settled: "false",
    selected: "false",
    stepKey: "schedule",
    mount: async () =>
      frameRow(
        <RunSurfaceRailRow
          selectionKey="schedule"
          label="Schedule"
          displayStep={1}
          conformanceId="run-surface-rail-step"
          action="open-schedule-step"
          reached
        />,
      ),
  },
  {
    id: "frame:recommendation",
    name: "the Skills / recommendation gate entry",
    where: "packages/agents/src/recommendation-rail-step.tsx:55",
    rowClass: RUN_SURFACE_RAIL_ROW_CLASS,
    reached: "true",
    settled: "true",
    selected: "false",
    // Its own anchors address it, as the schedule row's do — no selection key
    // is added to a drawn node by this leg.
    stepKey: null,
    mount: async () => frameRow(<RecommendationRailStepRow settled openable />),
  },
  {
    id: "frame:input:0",
    name: "the run's own input / setup step entry",
    where: "packages/agents/src/run-input-rail-steps.tsx:99 through run-surface-rail.tsx:328-351",
    rowClass: RUN_SURFACE_RAIL_ROW_CLASS,
    reached: "true",
    settled: "true",
    selected: "false",
    stepKey: "input:0",
    mount: async () =>
      frameRow(
        <RunSurfaceRailRow
          selectionKey="input:0"
          label="Setup"
          displayStep={1}
          conformanceId="run-surface-rail-step"
          action="open-input-step"
          reached
          settled
        />,
      ),
  },
  {
    id: "frame:review",
    name: "an entry still ahead (the upcoming Review)",
    where: "packages/agents/src/setup-run-surface-steps.tsx:75 through run-surface-rail.tsx:328-351",
    // A step still ahead cannot be opened, and the frame draws it in the rail's
    // OWN closed row declaration (run-surface-rail.tsx:349) — the same shared
    // row, stated for the row a reader cannot press.
    rowClass: RUN_SURFACE_RAIL_ROW_CLOSED_CLASS,
    reached: "false",
    settled: "false",
    selected: "false",
    stepKey: "review",
    mount: async () =>
      frameRow(
        <RunSurfaceRailRow
          selectionKey="review"
          label="Review"
          displayStep={2}
          conformanceId="run-surface-rail-step"
          action="review-step-unavailable"
          reached={false}
          selectable={false}
        />,
      ),
  },
  {
    id: "frame:gate",
    name: "the parked gate entry the run is standing on",
    where: "packages/agents/src/instance-screens.tsx:2570-2595 through RunSurfaceRailRow",
    rowClass: RUN_SURFACE_RAIL_ROW_CLASS,
    reached: "true",
    settled: "false",
    selected: "false",
    stepKey: "gate",
    mount: async () =>
      frameRow(
        <RunSurfaceRailRow
          selectionKey="gate"
          label="Pick one idea"
          displayStep={3}
          conformanceId="run-surface-rail-step"
          action="open-gate-step"
          reached
        />,
      ),
  },
  {
    id: "frame:made",
    name: "the record step, What this run made",
    where: "packages/agents/src/instance-screens.tsx:2782-2800 through RunSurfaceRailRow",
    rowClass: RUN_SURFACE_RAIL_ROW_CLASS,
    reached: "true",
    settled: "true",
    selected: "true",
    stepKey: "made",
    mount: async () =>
      frameRow(
        <RunSurfaceRailRow
          selectionKey="made"
          label="What this run made"
          displayStep={4}
          conformanceId="run-surface-rail-step"
          action="open-made-step"
          reached
          settled
        />,
        "made",
      ),
  },
  // The panel's ordinary work-step rows, in each status the kind takes.
  {
    id: "panel:step",
    name: "a panel work step, completed",
    where: "packages/agents/src/run-step-rail-panel.tsx:230-233",
    rowClass: RUN_PAGE_RAIL_ROW_CLASS,
    reached: "true",
    settled: "true",
    selected: "false",
    stepKey: null,
    mount: async () => panelEntry(step({ status: "completed" })),
  },
  {
    id: "panel:step",
    name: "a panel work step, pending — the step the run is standing on",
    where: "packages/agents/src/run-step-rail-panel.tsx:230-233",
    rowClass: RUN_PAGE_RAIL_ROW_CLASS,
    reached: "true",
    settled: "false",
    selected: "true",
    stepKey: null,
    mount: async () => panelEntry(step({ status: "pending" })),
  },
  {
    id: "panel:step",
    name: "a panel work step, upcoming",
    where: "packages/agents/src/run-step-rail-panel.tsx:230-233",
    rowClass: RUN_PAGE_RAIL_ROW_CLASS,
    reached: "false",
    settled: "false",
    selected: "false",
    stepKey: null,
    mount: async () => panelEntry(step({ status: "upcoming" })),
  },
  {
    id: "panel:step",
    name: "a panel work step, skipped",
    where: "packages/agents/src/run-step-rail-panel.tsx:230-233",
    rowClass: RUN_PAGE_RAIL_ROW_CLASS,
    reached: "true",
    settled: "true",
    selected: "false",
    stepKey: null,
    mount: async () => panelEntry(step({ status: "skipped" })),
  },
  {
    id: "panel:step",
    name: "a panel work step, resolved",
    where: "packages/agents/src/run-step-rail-panel.tsx:230-233",
    rowClass: RUN_PAGE_RAIL_ROW_CLASS,
    reached: "true",
    settled: "true",
    selected: "false",
    stepKey: null,
    mount: async () => panelEntry(step({ status: "resolved" })),
  },
  {
    id: "panel:step",
    name: "a panel work step that opens nothing — the inert row",
    where: "packages/agents/src/run-step-rail-panel.tsx:222-228",
    rowClass: RUN_PAGE_RAIL_ROW_CLASS,
    reached: "true",
    settled: "true",
    selected: "false",
    stepKey: null,
    mount: async () => panelEntry(step({ status: "completed", openable: false })),
  },
  {
    id: "panel:gate",
    name: "the pending gate entry that opens in the run detail",
    where: "packages/agents/src/run-step-rail-extra-entry.tsx:452-484",
    rowClass: RUN_PAGE_RAIL_ROW_CLASS,
    reached: "true",
    settled: "false",
    selected: "true",
    stepKey: null,
    mount: async () =>
      extraEntry(
        {
          key: "gate:pending",
          ordinal: 2,
          kind: "gate",
          label: "Review",
          status: "pending",
          sources: [],
          gate: { gateId: "g2", reviewTaskId: "task-pending", disposition: null, resolved: false },
        } as RunStepRailEntry,
        "detail",
      ),
  },
  {
    id: "panel:gate",
    name: "the resolved gate entry — the rail's read-only history row",
    where: "packages/agents/src/run-step-rail-extra-entry.tsx:490-512",
    rowClass: RUN_PAGE_RAIL_ROW_CLASS,
    reached: "true",
    settled: "true",
    selected: "false",
    stepKey: null,
    mount: async () =>
      extraEntry({
        key: "gate:resolved",
        ordinal: 3,
        kind: "gate",
        label: "Review",
        status: "resolved",
        sources: [],
        gate: { gateId: "g1", reviewTaskId: "task-resolved", disposition: "approved", resolved: true },
      } as RunStepRailEntry),
  },
  {
    id: "panel:verification",
    name: "the verification entry",
    where: "packages/agents/src/run-step-rail-extra-entry.tsx:516-534",
    rowClass: RUN_PAGE_RAIL_ROW_CLASS,
    reached: "true",
    settled: "true",
    selected: "false",
    stepKey: null,
    mount: async () =>
      extraEntry({
        key: "verification:task-resolved",
        ordinal: 4,
        kind: "verification",
        label: "Audit",
        status: "completed",
        sources: [],
        verification: { gateId: "g1", reviewTaskId: "task-resolved", outcome: "verified" },
      } as RunStepRailEntry),
  },
  {
    id: "panel:step",
    name: "the inert / surplus step-result entry",
    where: "packages/agents/src/run-step-rail-extra-entry.tsx:544-562",
    rowClass: RUN_PAGE_RAIL_ROW_CLASS,
    reached: "true",
    settled: "true",
    selected: "false",
    stepKey: null,
    mount: async () =>
      extraEntry({
        key: "step:surplus",
        ordinal: 5,
        kind: "step",
        label: "Step 6",
        status: "completed",
        sources: [],
        openable: false,
      } as RunStepRailEntry),
  },
  {
    id: "panel:lifecycleDecision",
    name: "the lifecycle-decision entry",
    where: "packages/agents/src/run-step-rail-extra-entry.tsx:574-597",
    rowClass: RUN_PAGE_RAIL_ROW_CLASS,
    reached: "true",
    settled: "true",
    selected: "false",
    stepKey: null,
    mount: async () =>
      extraEntry({
        key: "lifecycle:event-9",
        ordinal: 6,
        kind: "lifecycleDecision",
        label: "Review skipped",
        status: "skipped",
        sources: [],
        lifecycleDecision: {
          eventId: "event-9",
          artifactId: "artifact-9",
          outcome: "skipped",
          decidedBy: "org-bound",
          latticeOutcome: "skip",
          reason: "The org policy skips review for outreach drafts.",
        },
      } as RunStepRailEntry),
  },
  {
    id: "spine:step",
    name: "the second mount's own spine step row",
    where: "packages/agents/src/orchestrator-stepper-panel.tsx:1341-1350",
    rowClass: RUN_PAGE_RAIL_ROW_CLASS,
    // The one spine step of a run this panel draws as under way reads COMPLETED
    // on its own spine (`isCompleted`, the step's index against the panel's
    // active one), which the rail's vocabulary makes reached and settled, and
    // it is not the row the reader is standing on.
    reached: "true",
    settled: "true",
    selected: "false",
    stepKey: null,
    mount: async () => {
      const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ reviewGate: { ref: null, awaiting: false } }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
        ),
      );
      const { container } = render(
        <OrchestratorStepperPanel
          runId="run-3449"
          initialStatus="running"
          initialError={null}
          agUiEnabled={false}
          agentPackageName="@cinatra-ai/blog-idea-generator-agent"
          inputParams={{}}
          stepperSteps={[{ index: 1, stepNumber: 0, label: "Campaign setup" }]}
          agentId="cinatra-ai/blog-idea-generator-agent"
          lgThreadId={null}
          templateId="tmpl-3449"
          templateName="Blog Idea Generator Agent"
        />,
      );
      return entryWrapper(container);
    },
  },
];

// ---------------------------------------------------------------------------
// THE READING, per kind.
// ---------------------------------------------------------------------------
function tokens(className: string): string[] {
  return className.split(/\s+/).filter(Boolean);
}

/**
 * THE CANDIDATE ROWS OF THE RAIL, READ WITHOUT THE MARK. This is the union
 * `run-page-rail-rhythm.test.tsx:364-368` collects the composed rail's rows
 * with, with the `[data-run-surface-rail-step]` member DROPPED — reading it
 * here is what made the old per-kind reading circular — the inert row's own
 * anchor added (`run-step-rail-panel.tsx:244`,
 * `run-step-rail-extra-entry.tsx:564`), and the frame row's own control anchor
 * standing in for the dropped member: the frame's generic row
 * (`run-surface-rail.tsx:329`), the schedule row (`schedule-rail-step.tsx:128`)
 * and the recommendation row (`recommendation-rail-step.tsx:82`) each draw
 * their row as the design system's Button, whose own slot is
 * `data-slot="button"` (`src/components/ui/button.tsx:63`) — the rhythm
 * suite catches those three through the mark, which this reading may not.
 * Not one member reads a `data-run-surface-rail-*` attribute.
 */
const ROW_CANDIDATES = [
  '[data-slot="stepper-trigger"]',
  "a[data-rail-gate-link]",
  "a[data-rail-verification-link]",
  "[data-rail-inert]",
  '[data-slot="button"]',
].join(", ");

describe("every kind of rail entry marks its state on its own row (cinatra#3449)", () => {
  for (const kind of KINDS) {
    it(`${kind.name} — one marked row, carrying every mark (${kind.where})`, async () => {
      const entry = await kind.mount();

      // THE ENTRY'S ROW BOX, FOUND FIRST AND FOUND WITHOUT THE MARK. The scope
      // is the entry's own `[data-rail-kind]` wrapper for a page-rail entry and
      // the rail column for a frame row — and where a mount draws one entry
      // alone, the entry's subtree IS its position in that column's ordered row
      // list, so the one candidate carrying the shared row class is the row at
      // the entry's own position.
      const scope = entry.closest<HTMLElement>("[data-run-step-rail-column]") ?? entry;
      const candidates = [
        ...(scope.matches(ROW_CANDIDATES) ? [scope] : []),
        ...Array.from(scope.querySelectorAll<HTMLElement>(ROW_CANDIDATES)),
      ];
      // THE ROW BOX IS THE CANDIDATE CARRYING THE SHARED ROW CLASS THE KIND
      // DRAWS — never the box around it, and never a node named by the mark.
      const rowBoxes = candidates.filter((node) =>
        tokens(kind.rowClass).every((token) => tokens(node.className).includes(token)),
      );
      expect(
        rowBoxes,
        `${kind.name}: one row box in the entry, found without reading the mark`,
      ).toHaveLength(1);
      const rowBox = rowBoxes[0]!;

      // ONE node per drawn entry, THE ENTRY'S OWN BOX INCLUDED: a wrapper and
      // the row inside it counted as two is the reading the picture rounds kept
      // measuring, and `querySelectorAll` walks descendants only — a mark that
      // landed on the wrapper this reading starts from would never be seen.
      const marked = [
        ...(entry.matches("[data-run-surface-rail-step]") ? [entry] : []),
        ...Array.from(entry.querySelectorAll<HTMLElement>("[data-run-surface-rail-step]")),
      ];
      expect(marked, `${kind.name}: exactly one marked node in the entry`).toHaveLength(1);
      const row = marked[0]!;

      // AND THE MARKED NODE *IS* THE ENTRY'S ROW BOX — element identity, not
      // class containment: the two nodes were found by roads that share no
      // attribute, so this fails when a mark sits on a node that is not the
      // row the rail draws.
      expect(row, `${kind.name}: the marked node IS the entry's own row box`).toBe(rowBox);

      expect(row.getAttribute("data-run-surface-rail-reached")).toBe(kind.reached);
      expect(row.getAttribute("data-run-surface-rail-settled")).toBe(kind.settled);
      // PRESENT, never absent: a reading of a drawn entry never receives null
      // for a state mark.
      expect(row.getAttribute("data-run-surface-rail-selected")).toBe(kind.selected);

      // The selection key is the frame's own — a page-rail entry is not a frame
      // selection and carries none by design.
      expect(row.getAttribute("data-run-surface-rail-step-key")).toBe(kind.stepKey);
    });
  }
});

// ---------------------------------------------------------------------------
// AND THE ROW BOX SPANS THE RAIL COLUMN (cinatra#3449).
//
// The rail column states its own width (`run-step-rail-panel.tsx:105`,
// `w-52` — the 208px the third picture round measured). Inside it the vendored
// `Stepper` states a full width of its own (`src/components/reui/stepper.tsx:160`),
// but the vendored `StepperNav` is an INLINE-FLEX nav given a width only in the
// horizontal orientation (`src/components/reui/stepper.tsx:412-427`), so in the
// vertical orientation this rail uses it shrink-wraps to its widest child — and
// the panel mounted it with no class of its own. Every box below it states its
// width as a share of what is above it (the entry wrapper,
// `run-step-rail-extra-entry.tsx:422`, and the shared row class,
// `run-step-rail-extra-entry.tsx:97-98`), so the two review entries' rows
// resolved to the shrink-wrapped nav's width rather than the column's: 137px
// inside a 208px column, which is not the column's row. The nav states the
// column's width, and every drawn entry's row box spans it.
//
// A CLASS assertion, deliberately: jsdom lays nothing out, so no width is
// measured here — the widths are measured on a real finished run by the later
// picture round.
// ---------------------------------------------------------------------------
describe("the run page rail's own vertical nav spans the rail column (cinatra#3449)", () => {
  it("states the column's full width on the nav the panel mounts", () => {
    const { container } = render(
      <RunStepRailPanel
        entries={[step({ status: "completed" })]}
        activeOrdinal={null}
        reviewHrefBase="/agents/v/p/run/review"
      />,
    );

    const column = only(container, "[data-run-step-rail]");
    expect(
      tokens(column.className),
      "the rail column states its own width, which the nav is asked to span",
    ).toContain("w-52");

    const nav = only(column, '[data-slot="stepper-nav"][data-orientation="vertical"]');
    expect(
      tokens(nav.className),
      "the vertical rail nav states the full width of the column it is drawn in",
    ).toContain("w-full");
  });
});

// ---------------------------------------------------------------------------
// LAST — the table's kind list IS the rail's vocabulary, read from the types.
// ---------------------------------------------------------------------------
function repoFile(relative: string): string {
  const cwd = process.cwd();
  for (const candidate of [`${cwd}/${relative}`, `${cwd}/../../${relative}`]) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  throw new Error(`file not found: ${relative}`);
}

/** A member of a union type as this file names it: a string literal by its
 *  word, a template literal by its prefix and a star (`input:${number}` is one
 *  kind however many forms the run asks). */
function member(raw: string): string {
  const literal = raw.match(/^"([^"]+)"$/);
  if (literal) return literal[1]!;
  const template = raw.match(/^`([^`$]*)\$\{[^}]+\}`$/);
  if (template) return `${template[1]}*`;
  return raw;
}

/** The union members of `export type <name> = …;`, aliases resolved. */
function unionOf(source: string, name: string, seen = new Set<string>()): string[] {
  if (seen.has(name)) return [];
  seen.add(name);
  const declaration = source.match(new RegExp(`export type ${name} =([^;]+);`));
  expect(declaration, `${name} is declared in the source read`).not.toBeNull();
  const body = declaration![1]!.replace(/\/\*[\s\S]*?\*\//g, "").trim();

  const exclude = body.match(/^Exclude<\s*(\w+)\s*,\s*("[^"]+")\s*>$/);
  if (exclude) {
    const dropped = member(exclude[2]!);
    return unionOf(source, exclude[1]!, seen).filter((m) => m !== dropped);
  }

  return body
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) =>
      /^[A-Z]\w*$/.test(part) ? unionOf(source, part, seen) : [member(part)],
    );
}

/** The `kind` union of the rail entry interface, read from the interface. */
function railEntryKinds(source: string): string[] {
  const line = source.match(/\n\s*kind:\s*([^;]+);/);
  expect(line, "RunStepRailEntry declares its kind union").not.toBeNull();
  return line![1]!
    .split("|")
    .map((part) => member(part.trim()))
    .filter(Boolean);
}

describe("the table is the rail's whole vocabulary (cinatra#3449)", () => {
  it("names every RunStepRailEntry kind and every frame step key, read from the types", () => {
    const entryKinds = railEntryKinds(repoFile("packages/agents/src/run-step-rail.ts"));
    const frameKeys = unionOf(
      repoFile("packages/agents/src/run-surface-rail-step.ts"),
      "RunSurfaceRailStepKey",
    );

    const expected = new Set([
      ...frameKeys.map((key) => `frame:${key}`),
      ...entryKinds.map((kind) => `panel:${kind}`),
    ]);

    // The table's own ids, with an indexed input step read as the one kind it
    // is, and the second mount's spine row set aside: it is drawn from the
    // page's step list rather than from a rail entry, so it belongs to neither
    // vocabulary — it is in the table because the census names it.
    const tabled = new Set(
      KINDS.map((kind) => kind.id.replace(/^frame:input:\d+$/, "frame:input:*")).filter(
        (id) => !id.startsWith("spine:"),
      ),
    );

    expect([...tabled].sort()).toEqual([...expected].sort());
    // And the spine row is in the table, once.
    expect(KINDS.filter((kind) => kind.id.startsWith("spine:"))).toHaveLength(1);
  });
});
