// @vitest-environment jsdom
/**
 * ONE ELECTION ACROSS THE MERGED RAIL (cinatra#3149, item 3 — fix leg 10).
 *
 * The ratified drawing, `specs/app-artifact-review.html` section I, "The step
 * rail — merged steps and gate entries":
 *
 *   "The rail lists the run's steps in order, merged so that a gate is not a
 *    page outside the run but a step in the run: the ordinary work steps, and
 *    — inline at the point the run reached it — a gate entry (a Skills step to
 *    answer, a list to pick one thing from, a review to decide). The step the
 *    run is paused on is highlighted; steps already passed sit above it, steps
 *    still to come below."
 *
 * and section I.3:
 *
 *   "The run waits at each — one entry is highlighted at a time — and when a
 *    review is decided the rail keeps it as read-only history and moves to the
 *    next review beneath it (§I)."
 *
 * WHY THIS SUITE EXISTS BESIDE `run-rail-live-column-current-position`. That
 * one mounts the live column ALONE, with the frame's answer handed to it as a
 * prop, and it went green on a head whose live page still marked the wrong
 * row: on a real blog-pipeline run parked at its pick step the document's one
 * `aria-current="step"` sat on a `run-surface-rail-step` button reading
 * "1 Context" — a generic row the FRAME drew for the same pause the column had
 * already drawn as "1 Select blog idea" — while both of the column's own rows
 * carried none. A rail is one rail; a suite that can only see half of it can
 * only half-measure the reading.
 *
 * So this suite composes the surface the way the SCREEN composes it — the same
 * exported decisions (`runParkedAtTrailingGate`, `parkedGateRailStepLabel`,
 * `runDetailInitialStep`, `screenHostsStepRail`) driving the real
 * `RunSurfaceRail` frame with the real `OrchestratorStepperPanel` inside it —
 * and reads the WHOLE document, so it cannot pass while the live page fails.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-surface-merged-rail-one-current-entry.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

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
    ownKeys: () => ["Check", "ClipboardCheck", "Info", "Pause", "ScanSearch", "SkipForward", "default"],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});

vi.mock("@/lib/cinatra-toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/generated/field-renderer-components", () => ({
  GENERATED_FIELD_RENDERER_COMPONENTS: {},
}));

vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_MANIFEST: {},
  GENERATED_CONNECTOR_ENTRY_MODULES: {},
  GENERATED_CONNECTOR_MCP_MODULES: {},
  GENERATED_DEV_SETUP_MODULES: {},
  GENERATED_WIDGET_STREAM_AGENTS: {},
}));

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

const streamState: { status: string; interruptContext: unknown } = {
  status: "completed",
  interruptContext: null,
};

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: () => ({
    status: streamState.status,
    interruptContext: streamState.interruptContext,
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  streamState.status = "completed";
  streamState.interruptContext = null;
});

type PanelProps = import("../orchestrator-stepper-panel").OrchestratorStepperPanelProps;
type RailEntry = import("../run-step-rail").RunStepRailEntry;
type RailStep = import("../run-surface-rail-step").RunSurfaceRailStep;

/** The blog-pipeline shape read on the live boot: the pick step the run is
 *  parked on, and the review step drawn after it. */
const PICK_STEP_SPINE: PanelProps["stepperSteps"] = [
  { index: 1, stepNumber: 0, label: "Select blog idea", xRenderer: "idea-selection" },
  { index: 2, stepNumber: 1, label: "Review blog draft", xRenderer: "draft-review" },
];

/** A two-step spine for the ordered-gate readings; the gates trail it. */
const WORK_SPINE: PanelProps["stepperSteps"] = [
  { index: 1, stepNumber: 0, label: "Drafted the post", xRenderer: "draft" },
  { index: 2, stepNumber: 1, label: "Drafted the image", xRenderer: "draft" },
];

function reviewGate(
  reviewTaskId: string,
  status: "pending" | "resolved",
  ordinal: number,
): RailEntry {
  return {
    key: `gate:${reviewTaskId}`,
    ordinal,
    kind: "gate",
    label: "Review",
    status,
    sources: ["gate"],
    gate: {
      gateId: `gate-${reviewTaskId}`,
      reviewTaskId,
      disposition: status === "resolved" ? "approved" : null,
      resolved: status === "resolved",
    },
  };
}

/**
 * THE SURFACE, COMPOSED THE WAY THE SCREEN COMPOSES IT.
 *
 * Every decision below is the screen's own exported one, taken from the same
 * facts the screen reads off the run — so a rule that changes in
 * `instance-screens.tsx` changes here too, and this suite cannot drift into
 * measuring a composition the run page does not draw.
 */
async function buildRunSurface(params: {
  spine: PanelProps["stepperSteps"];
  railExtras?: readonly RailEntry[];
  runStatus: string;
  lifecycleMoment: string | null;
  gateContextUsable: boolean;
  /** A Skills question the run has already answered — its entry stays on the
   *  rail as the drawing's read-only history, so the FRAME is mounted. */
  settledSkillsEntry?: boolean;
  /** A schedule the run already holds a row for — the frame draws it, and a run
   *  with no execution record yet used to OPEN on it. */
  scheduleEntry?: boolean;
  hasExecution?: boolean;
  gateValues?: Record<string, unknown> | null;
}) {
  const {
    runParkedAtTrailingGate,
    parkedGateDrawnByTheLiveColumn,
    gateStepNumberInValues,
    parkedGateRailStepLabel,
    runDetailInitialStep,
  } = await import("../instance-screens");
  const { RunSurfaceRail, RunSurfaceRailRow } = await import("../run-surface-rail");
  const { isRunSurfaceStepSelectable, runSurfaceRailNumberedCount } = await import(
    "../run-surface-rail-step"
  );
  const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");

  const hasRecommendationStep = params.settledSkillsEntry === true;
  const hasScheduleStep = params.scheduleEntry === true;
  const parkedGateStep = runParkedAtTrailingGate({
    runStatus: params.runStatus,
    lifecycleMoment: params.lifecycleMoment,
    gateContextUsable: params.gateContextUsable,
    recommendationHeld: false,
    openInputStepKey: null,
  });
  const parkedGateStepNumber = gateStepNumberInValues(params.gateValues ?? null);
  const parkedGateOnTheLiveColumn = parkedGateDrawnByTheLiveColumn({
    parkedGateStep,
    panel: "stepper",
    spineStepNumbers: params.spine.map((step) => step.stepNumber),
    gateStepNumber: parkedGateStepNumber,
  });
  const parkedGateRowOnTheFrame = parkedGateStep && !parkedGateOnTheLiveColumn;
  const parkedGateStepLabel = parkedGateStep
    ? parkedGateRailStepLabel({ values: params.gateValues ?? null, fieldName: null })
    : null;
  const initialStep = runDetailInitialStep({
    openInputStepKey: null,
    hasRecommendationStep,
    recommendationHeld: false,
    hasScheduleStep,
    hasExecution: params.hasExecution ?? true,
    parkedGateStep,
    parkedGateDrawnByTheLiveColumn: parkedGateOnTheLiveColumn,
  });
  const railFramesTheRunDetail =
    hasRecommendationStep || hasScheduleStep || parkedGateRowOnTheFrame;
  const frameElectsTheCurrentEntry = railFramesTheRunDetail && initialStep !== "detail";

  const detail = (
    <OrchestratorStepperPanel
      runId="run-3149"
      initialStatus={params.runStatus}
      initialError={null}
      agUiEnabled={false}
      agentPackageName="@cinatra-ai/blog-pipeline-agent"
      inputParams={{}}
      stepperSteps={params.spine}
      agentId="cinatra-ai/blog-pipeline-agent"
      lgThreadId={null}
      templateId="tmpl-3149"
      templateName="Blog Pipeline Agent"
      railExtras={params.railExtras ?? []}
      reviewHrefBase="/agents/cinatra-ai%2Fblog-pipeline-agent/run-3149/review"
      railDrawsTheFrame={railFramesTheRunDetail}
      frameElectsTheCurrentEntry={frameElectsTheCurrentEntry}
      initialGateStepNumber={parkedGateOnTheLiveColumn ? parkedGateStepNumber : null}
    />
  );

  const railSteps: RailStep[] = [];
  if (hasRecommendationStep) {
    const skillsStep: RailStep = {
      key: "recommendation",
      reached: true,
      settled: true,
      surface: null,
      row: null,
    };
    railSteps.push({
      ...skillsStep,
      row: (
        <RunSurfaceRailRow
          selectionKey="recommendation"
          label="Skills"
          displayStep={null}
          reached
          settled
          selectable={isRunSurfaceStepSelectable(skillsStep, detail)}
          conformanceId="run-surface-rail-step"
          indicatorConformanceId="run-surface-rail-indicator"
          action="open-recommendation-step"
        />
      ),
    });
  }
  if (hasScheduleStep) {
    const scheduleStep: RailStep = {
      key: "schedule",
      reached: true,
      settled: false,
      surface: <div data-testid="schedule-form">Schedule form</div>,
      row: null,
    };
    railSteps.push({
      ...scheduleStep,
      row: (
        <RunSurfaceRailRow
          selectionKey="schedule"
          label="Schedule"
          displayStep={runSurfaceRailNumberedCount(railSteps.map((s) => s.key)) + 1}
          reached
          settled={false}
          selectable={isRunSurfaceStepSelectable(scheduleStep, detail)}
          conformanceId="run-surface-rail-step"
          indicatorConformanceId="run-surface-rail-indicator"
          action="open-schedule-step"
        />
      ),
    });
  }
  if (parkedGateRowOnTheFrame && parkedGateStepLabel) {
    const gateStep: RailStep = {
      key: "gate",
      reached: true,
      settled: false,
      surface: null,
      row: null,
    };
    railSteps.push({
      ...gateStep,
      row: (
        <RunSurfaceRailRow
          selectionKey="gate"
          label={parkedGateStepLabel}
          displayStep={runSurfaceRailNumberedCount(railSteps.map((s) => s.key)) + 1}
          reached
          settled={false}
          selectable={isRunSurfaceStepSelectable(gateStep, detail)}
          conformanceId="run-surface-rail-step"
          indicatorConformanceId="run-surface-rail-indicator"
          action="open-gate-step"
        />
      ),
    });
  }

  return railSteps.length > 0 ? (
    <RunSurfaceRail steps={railSteps} detail={detail} initialSelection={initialStep} />
  ) : (
    detail
  );
}

/** Mount it, and keep a rebuild that re-renders the SAME mount — so a ref the
 *  live column holds across frames is exercised rather than reset. */
async function renderRunSurface(params: Parameters<typeof buildRunSurface>[0]) {
  const tree = await buildRunSurface(params);
  const { rerender } = render(tree);
  return {
    rebuild: async () => rerender(await buildRunSurface(params)),
  };
}

/** Every marker in the WHOLE document — the reading the live boot takes. */
function markedInTheDocument(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[aria-current="step"]'));
}

/** What a marked row reads out, whichever of the rail's modules drew it. */
function labelOf(row: HTMLElement): string {
  const title = row.querySelector<HTMLElement>('[data-slot="stepper-title"]');
  return (title ?? row).textContent?.replace(/\s+/g, " ").trim() ?? "";
}

describe("the merged rail elects the current entry once (cinatra#3149 item 3)", () => {
  it("marks the PICK step the run is parked on — and draws no second, generic row for the same pause", async () => {
    streamState.status = "pending_approval";
    streamState.interruptContext = {
      xRenderer: "@cinatra-ai/blog-pipeline-agent:idea-selection",
      reviewTaskId: "wayflow-pick",
      fieldName: null,
      values: { stepNumber: 0 },
      schema: {},
    };
    await renderRunSurface({
      spine: PICK_STEP_SPINE,
      runStatus: "pending_approval",
      lifecycleMoment: "hitl",
      gateContextUsable: true,
      gateValues: { stepNumber: 0 },
    });
    const marked = markedInTheDocument();
    expect(marked.length).toBe(1);
    expect(labelOf(marked[0]!)).toBe("Select blog idea");
    // The generic row the frame used to draw for this same pause — "Context" —
    // is not on the rail at all: the column already carries the step's own
    // entry, and the drawing names no such control anywhere.
    expect(document.body.textContent).not.toContain("Context");
    expect(
      document.querySelectorAll('[data-run-surface-rail-step-key="gate"]').length,
    ).toBe(0);
  });

  it("marks the WORK step the run is paused on, under a settled Skills entry the frame draws", async () => {
    streamState.status = "pending_approval";
    streamState.interruptContext = {
      xRenderer: "@cinatra-ai/blog-pipeline-agent:draft-review",
      reviewTaskId: "wayflow-work",
      fieldName: null,
      values: { stepNumber: 0 },
      schema: {},
    };
    await renderRunSurface({
      spine: WORK_SPINE,
      runStatus: "pending_approval",
      lifecycleMoment: "hitl",
      gateContextUsable: true,
      settledSkillsEntry: true,
      gateValues: { stepNumber: 0 },
    });
    const marked = markedInTheDocument();
    expect(marked.length).toBe(1);
    expect(labelOf(marked[0]!)).toBe("Drafted the post");
  });

  it("keeps the FRAME's own row, and its marker, for a parked gate the column carries no entry for", async () => {
    // A runtime gate that names no step number is on no row of the spine, and
    // the live column's election falls back to its FIRST row for such a run —
    // unrelated work, marked while the gate's card stands open. The frame's own
    // row is the entry for this pause, so it stays, and it is the one marked.
    streamState.status = "pending_approval";
    streamState.interruptContext = {
      xRenderer: "@cinatra-ai/context-selection-agent:context-selector",
      reviewTaskId: "wayflow-ctx",
      fieldName: null,
      values: {},
      schema: {},
    };
    await renderRunSurface({
      spine: WORK_SPINE,
      runStatus: "pending_approval",
      lifecycleMoment: "hitl",
      gateContextUsable: true,
      gateValues: {},
    });
    const marked = markedInTheDocument();
    expect(marked.length).toBe(1);
    expect(marked[0]!.getAttribute("data-run-surface-rail-step-key")).toBe("gate");
  });

  it("does not open a run's SCHEDULE over the live gate it is parked at", async () => {
    // A scheduled run parked at a mid-run gate before any execution evidence is
    // persisted: the schedule row is on the frame, and the initial-selection
    // ladder must stop at the gate rather than fall through to "schedule" and
    // put the scheduling form where the gate's card belongs.
    streamState.status = "pending_approval";
    streamState.interruptContext = {
      xRenderer: "@cinatra-ai/blog-pipeline-agent:draft-review",
      reviewTaskId: "wayflow-sched",
      fieldName: null,
      values: { stepNumber: 0 },
      schema: {},
    };
    await renderRunSurface({
      spine: WORK_SPINE,
      runStatus: "pending_approval",
      lifecycleMoment: "hitl",
      gateContextUsable: true,
      scheduleEntry: true,
      hasExecution: false,
      gateValues: { stepNumber: 0 },
    });
    expect(document.querySelectorAll('[data-testid="schedule-form"]').length).toBe(0);
    const marked = markedInTheDocument();
    expect(marked.length).toBe(1);
    expect(labelOf(marked[0]!)).toBe("Drafted the post");
  });

  it("marks the FIRST of two ordered gates while the run waits at it", async () => {
    streamState.status = "completed";
    await renderRunSurface({
      spine: WORK_SPINE,
      railExtras: [reviewGate("rt-post", "pending", 3), reviewGate("rt-image", "pending", 4)],
      runStatus: "completed",
      lifecycleMoment: null,
      gateContextUsable: false,
      settledSkillsEntry: true,
    });
    const marked = markedInTheDocument();
    expect(marked.length).toBe(1);
    expect(marked[0]!.getAttribute("data-rail-kind")).toBe("gate");
    expect(marked[0]!.getAttribute("data-rail-status")).toBe("pending");
    const gateRows = Array.from(
      document.querySelectorAll<HTMLElement>('[data-rail-kind="gate"]'),
    );
    expect(gateRows.length).toBe(2);
    expect(gateRows[0]).toBe(marked[0]);
  });

  it("moves the marker to the SECOND gate once the first is decided", async () => {
    streamState.status = "completed";
    await renderRunSurface({
      spine: WORK_SPINE,
      railExtras: [reviewGate("rt-post", "resolved", 3), reviewGate("rt-image", "pending", 4)],
      runStatus: "completed",
      lifecycleMoment: null,
      gateContextUsable: false,
      settledSkillsEntry: true,
    });
    const marked = markedInTheDocument();
    expect(marked.length).toBe(1);
    expect(marked[0]!.getAttribute("data-rail-status")).toBe("pending");
    const gateRows = Array.from(
      document.querySelectorAll<HTMLElement>('[data-rail-kind="gate"]'),
    );
    expect(gateRows.length).toBe(2);
    expect(gateRows[1]).toBe(marked[0]);
  });

  it("stands the reader at the parked step from the FIRST paint, before the stream delivers the gate", async () => {
    // The live column's stream opens with no interrupt, so its own election has
    // no step number and falls back to the FIRST row. On a spine whose policy
    // numbers start above 1 that row is not the step the run is parked at — and
    // this is the class of run whose frame row was stood down, so the wrong row
    // would be the surface's only marker until a frame arrived.
    streamState.status = "pending_approval";
    streamState.interruptContext = null;
    await renderRunSurface({
      spine: [
        { index: 1, stepNumber: 2, label: "Drafted the post", xRenderer: "draft" },
        { index: 2, stepNumber: 4, label: "Picked the image", xRenderer: "image-pick" },
      ],
      runStatus: "pending_approval",
      lifecycleMoment: "hitl",
      gateContextUsable: true,
      gateValues: { stepNumber: 4 },
    });
    const marked = markedInTheDocument();
    expect(marked.length).toBe(1);
    expect(labelOf(marked[0]!)).toBe("Picked the image");
  });

  it("retires the server's seed once the stream has delivered a gate, and does not take it back", async () => {
    // A RESUME frame clears the interrupt WITHOUT leaving `pending_approval`.
    // A seed retired only while an interrupt is present would come back then
    // and stand the reader at a step the run has already passed.
    const spine: PanelProps["stepperSteps"] = [
      { index: 1, stepNumber: 2, label: "Drafted the post", xRenderer: "draft" },
      { index: 2, stepNumber: 4, label: "Picked the image", xRenderer: "image-pick" },
      { index: 3, stepNumber: 6, label: "Filed the post", xRenderer: "file" },
    ];
    streamState.status = "pending_approval";
    streamState.interruptContext = null;
    // The server read the run parked at its LAST step — a step the election's
    // own fallback never returns, so the seed's answer and the fallback's are
    // told apart rather than coinciding.
    const { rebuild } = await renderRunSurface({
      spine,
      runStatus: "pending_approval",
      lifecycleMoment: "hitl",
      gateContextUsable: true,
      gateValues: { stepNumber: 6 },
    });
    expect(labelOf(markedInTheDocument()[0]!)).toBe("Filed the post");

    // The stream delivers the live gate…
    streamState.interruptContext = {
      xRenderer: "@cinatra-ai/blog-pipeline-agent:image-pick",
      reviewTaskId: "wayflow-image",
      fieldName: null,
      values: { stepNumber: 4 },
      schema: {},
    };
    await rebuild();
    expect(labelOf(markedInTheDocument()[0]!)).toBe("Picked the image");

    // …and a RESUME clears it while the run stays `pending_approval`. The seed
    // is SPENT: never consulted again, so the marker cannot jump back to the
    // step the server read before the stream took over.
    streamState.interruptContext = null;
    await rebuild();
    const marked = markedInTheDocument();
    expect(marked.length).toBe(1);
    expect(labelOf(marked[0]!)).not.toBe("Filed the post");
  });

  it("marks NOTHING once every entry on the merged rail is settled", async () => {
    streamState.status = "completed";
    await renderRunSurface({
      spine: WORK_SPINE,
      railExtras: [reviewGate("rt-post", "resolved", 3), reviewGate("rt-image", "resolved", 4)],
      runStatus: "completed",
      lifecycleMoment: null,
      gateContextUsable: false,
      settledSkillsEntry: true,
    });
    expect(markedInTheDocument().length).toBe(0);
  });
});
