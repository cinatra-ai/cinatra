// @vitest-environment jsdom
/**
 * THE LIVE RAIL SAYS WHERE THE READER STANDS (cinatra#3149, item 3).
 *
 * The ratified drawing, `specs/app-artifact-review.html` section I, "The step
 * rail — merged steps and gate entries":
 *
 *   "The step the run is paused on is highlighted; steps already passed sit
 *    above it, steps still to come below."
 *
 * and section I.3:
 *
 *   "The run waits at each — one entry is highlighted at a time — and when a
 *    review is decided the rail keeps it as read-only history and moves to the
 *    next review beneath it (§I)."
 *
 * WHAT THIS SUITE ADDS TO THE ONE NEXT DOOR. `run-rail-current-position-marker`
 * pins the PAGE-LEVEL rail (`RunStepRailPanel`), which writes the marker and
 * has done since fix leg 8. On the flow/orchestrator branch that panel stands
 * down and the LIVE column inside `OrchestratorStepperPanel` is the one rail
 * (`screenHostsStepRail`) — and that column wrote the marker NOWHERE. Measured
 * on the live boot before this leg, on a real run of
 * `@cinatra-ai/email-outreach-agent` parked on its first step: five rail rows,
 * `data-rail-status="pending"` on the row the run stands at, and
 * `aria-current` null on every one of them — nothing in the document carried
 * the marker at all.
 *
 * THE ELECTION IS ALREADY WRITTEN AND ALREADY PURE. `electRunRailActiveStep`
 * answers "the display index of the entry the run is parked on" across the
 * spine AND the trailing rows, and returns a number past every row when the run
 * stands at none. The column already takes that number as its `activeStep`. So
 * the marker is that number written into the DOM, and nothing else moves.
 *
 * ONE AT A TIME MEANS THE WHOLE COLUMN. Where the page's own rail frames the
 * run detail it draws the rows the reader is standing on and marks one of them
 * itself (`run-surface-rail.tsx`); the live column stands down there, exactly
 * as the page-level rail does, so the surface carries one marker and never two.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-rail-live-column-current-position.test.tsx
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

/** The live stream, driven per test: the status the run is in and — where the
 *  run is parked on a spine step — the interrupt that names that step. */
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

/** The blog-pipeline shape the eighth round read on the live boot: a pick step
 *  the run is parked on, and the review step drawn after it. */
const PICK_STEP_SPINE: PanelProps["stepperSteps"] = [
  { index: 1, stepNumber: 0, label: "Select blog idea", xRenderer: "idea-selection" },
  { index: 2, stepNumber: 1, label: "Review blog draft", xRenderer: "draft-review" },
];

/** A two-step spine for the ordered-gate readings; the gates trail it. */
const WORK_SPINE: PanelProps["stepperSteps"] = [
  { index: 1, stepNumber: 0, label: "Drafted the post", xRenderer: "draft" },
  { index: 2, stepNumber: 1, label: "Drafted the image", xRenderer: "draft" },
];

function reviewGate(reviewTaskId: string, status: "pending" | "resolved", ordinal: number): RailEntry {
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

function baseProps(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    runId: "run-3149",
    initialStatus: "completed",
    initialError: null,
    agUiEnabled: false as boolean | null,
    agentPackageName: "@cinatra-ai/blog-pipeline-agent",
    inputParams: {},
    stepperSteps: PICK_STEP_SPINE,
    agentId: "cinatra-ai/blog-pipeline-agent",
    lgThreadId: null,
    templateId: "tmpl-3149",
    templateName: "Blog Pipeline Agent",
    railExtras: [],
    reviewHrefBase: "/agents/cinatra-ai%2Fblog-pipeline-agent/run-3149/review",
    ...overrides,
  };
}

/** The rail the flow branch draws, and the rows inside it that carry the
 *  marker — read exactly as a walk of the live DOM reads them. */
function railRoot(): HTMLElement {
  const rails = document.querySelectorAll<HTMLElement>("[data-run-step-rail]");
  expect(rails.length).toBe(1);
  return rails[0]!;
}

function markedRows(): HTMLElement[] {
  return Array.from(railRoot().querySelectorAll<HTMLElement>('[aria-current="step"]'));
}

function titleOf(row: HTMLElement): string {
  return row.querySelector<HTMLElement>('[data-slot="stepper-title"]')?.textContent ?? "";
}

describe("the live rail column marks the one entry the run is paused on (cinatra#3149 item 3)", () => {
  it("marks the PICK step the run is parked on, and no other entry", async () => {
    streamState.status = "pending_approval";
    streamState.interruptContext = {
      xRenderer: "@cinatra-ai/blog-pipeline-agent:idea-selection",
      reviewTaskId: "wayflow-pick",
      fieldName: null,
      values: { stepNumber: 0 },
      schema: {},
    };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps({ initialStatus: "pending_approval" })} />);
    const marked = markedRows();
    expect(marked.length).toBe(1);
    expect(titleOf(marked[0]!)).toBe("Select blog idea");
    expect(marked[0]!.getAttribute("data-rail-kind")).toBe("step");
  });

  it("marks the FIRST of two ordered gates while the run waits at it", async () => {
    streamState.status = "completed";
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(
      <OrchestratorStepperPanel
        {...baseProps({
          stepperSteps: WORK_SPINE,
          railExtras: [reviewGate("rt-post", "pending", 3), reviewGate("rt-image", "pending", 4)],
        })}
      />,
    );
    const marked = markedRows();
    expect(marked.length).toBe(1);
    expect(marked[0]!.getAttribute("data-rail-kind")).toBe("gate");
    expect(marked[0]!.getAttribute("data-rail-status")).toBe("pending");
    // …and it is the FIRST gate row, not the second.
    const gateRows = Array.from(
      railRoot().querySelectorAll<HTMLElement>('[data-rail-kind="gate"]'),
    );
    expect(gateRows.length).toBe(2);
    expect(gateRows[0]).toBe(marked[0]);
  });

  it("moves the marker to the SECOND gate once the first is decided", async () => {
    streamState.status = "completed";
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(
      <OrchestratorStepperPanel
        {...baseProps({
          stepperSteps: WORK_SPINE,
          railExtras: [reviewGate("rt-post", "resolved", 3), reviewGate("rt-image", "pending", 4)],
        })}
      />,
    );
    const marked = markedRows();
    expect(marked.length).toBe(1);
    expect(marked[0]!.getAttribute("data-rail-status")).toBe("pending");
    const gateRows = Array.from(
      railRoot().querySelectorAll<HTMLElement>('[data-rail-kind="gate"]'),
    );
    expect(gateRows.length).toBe(2);
    expect(gateRows[1]).toBe(marked[0]);
  });

  it("marks NOTHING on a finished rail whose every gate is settled", async () => {
    streamState.status = "completed";
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(
      <OrchestratorStepperPanel
        {...baseProps({
          stepperSteps: WORK_SPINE,
          railExtras: [reviewGate("rt-post", "resolved", 3), reviewGate("rt-image", "resolved", 4)],
        })}
      />,
    );
    expect(markedRows().length).toBe(0);
  });

  it("stands down where the page's own rail frames the run detail — one marker on the surface, never two", async () => {
    // The page's own rail draws the rows the reader is standing on there and
    // marks one of them itself. Measured on the live boot: a blog-pipeline run
    // parked at its context gate carries the marker on that rail's own row, and
    // a second marker written here would be two places to stand.
    streamState.status = "pending_approval";
    streamState.interruptContext = {
      xRenderer: "@cinatra-ai/context-selection-agent:context-selector",
      reviewTaskId: "wayflow-ctx",
      fieldName: null,
      values: { stepNumber: 0 },
      schema: {},
    };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(
      <OrchestratorStepperPanel
        {...baseProps({ initialStatus: "pending_approval", railDrawsTheFrame: true })}
      />,
    );
    expect(markedRows().length).toBe(0);
  });
});
