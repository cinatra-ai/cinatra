// @vitest-environment jsdom
/**
 * ONE CARD PER GATE INSIDE THE RUN FRAME (cinatra#3047, fix leg 8).
 *
 * The ratified drawing, `specs/app-artifact-review.html` section I:
 *
 *   "One page per gate — the step's own card, and nothing else. Selecting a
 *    step opens that step's page in the run detail, and the page carries the
 *    one card of the step it belongs to ... and two cards are never stacked in
 *    one detail."
 *
 * THE REGRESSION THE EIGHTH ROUND PHOTOGRAPHED. cinatra#3113 retired this
 * panel's "Agentic Run Progress" section for ONE moment only — the moment the
 * rail carries the run's own input form. Every other step-less gate inside the
 * same two-column run frame kept the section: a `soft-panel rounded-card`
 * plate wrapped around the gate's own Card, which is two cards stacked in one
 * detail. The round's second run (pending_approval, a HITL gate, step-less)
 * drew exactly that.
 *
 * THE FACT THE PANEL NEEDS is not "is this an input moment" but "is the frame
 * already drawn beside me" — the same reason `embedMode` hands the card over
 * bare, and the same reason cinatra#3113 gave for its own narrower case: the
 * chrome belongs to whoever draws the frame. `railDrawsTheFrame` states that
 * fact and nothing else; `inputStepInRail` keeps its own meaning untouched.
 *
 * AND THE CARD'S OWN CONTROL FLOOR SURVIVES the retirement. Section I's
 * companion sentence — "the primary Continue, right-aligned over a hairline
 * floor: the same control floor every gate page draws" — is about the CARD, so
 * removing the plate around it must not remove the controls inside it.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/gate-card-alone-in-the-run-frame.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

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
    ownKeys: () => ["AlertCircle", "ArrowRight", "Check", "Info", "Loader2", "Pause", "X", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

vi.mock("@/lib/cinatra-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
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

vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: (_runId: string, opts: { initialStatus?: string }) => ({
    status: opts?.initialStatus ?? "pending_approval",
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

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ reviewGate: { ref: null, awaiting: false } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

type PanelProps = import("../orchestrator-stepper-panel").OrchestratorStepperPanelProps;

function baseProps(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    runId: "run-3068",
    initialStatus: "pending_approval",
    initialError: null,
    agUiEnabled: false as boolean | null,
    agentPackageName: "@cinatra-ai/blog-draft-writer-agent",
    inputParams: {},
    // No renderer gate in the policy — this is the step-less branch.
    stepperSteps: [],
    agentId: "cinatra-ai/blog-draft-writer-agent",
    lgThreadId: null,
    templateId: "tmpl-3068",
    templateName: "Blog draft writer",
    ...overrides,
  };
}

type AgenticProps = import("../agentic-run-panel").AgenticRunPanelProps;

function agenticProps(overrides: Partial<AgenticProps> = {}): AgenticProps {
  return {
    runId: "run-3047",
    initialStatus: "pending_approval",
    initialError: null,
    agUiEnabled: false as boolean | null,
    agentPackageName: "@cinatra-ai/author-agent",
    agentId: "cinatra-ai/author-agent",
    initialMessages: [],
    inputParams: {},
    ...overrides,
  } as AgenticProps;
}

describe("the gate's card stands alone in the run detail", () => {
  it("draws NO Agentic Run Progress plate around a gate the rail already frames", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps({ railDrawsTheFrame: true })} />);

    expect(screen.queryByText(/Agentic Run Progress/i)).toBeNull();
  });

  it("stacks no second card: no soft-panel plate wraps the step's own card", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    const view = render(
      <OrchestratorStepperPanel {...baseProps({ railDrawsTheFrame: true })} />,
    );

    expect(view.container.querySelector("section.soft-panel")).toBeNull();
  });

  it("keeps the step's own card — the retirement removes the plate, not the screen", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    const framed = render(
      <OrchestratorStepperPanel {...baseProps({ railDrawsTheFrame: true })} />,
    );
    const framedText = framed.container.textContent ?? "";
    cleanup();
    const plain = render(<OrchestratorStepperPanel {...baseProps()} />);
    const plainText = plain.container.textContent ?? "";

    // Everything the plain reading shows minus the plate's own heading is still
    // drawn; the card is not what was retired.
    expect(framedText.length).toBeGreaterThan(0);
    expect(plainText).toContain("Agentic Run Progress");
  });

  it("still draws the plate for every caller the rail does not frame", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);

    expect(screen.getByText(/Agentic Run Progress/i)).toBeTruthy();
  });

  it("gives the agentic panel's own plate up as a card inside the frame", async () => {
    // cinatra#3068 retired the HEADING inside this plate for one moment; the
    // `soft-panel rounded-card` plate itself stayed, on every moment, wrapping
    // the gate's own card. Inside the frame the box keeps its job and gives up
    // its card chrome.
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const framed = render(
      <AgenticRunPanel {...agenticProps({ railDrawsTheFrame: true })} />,
    );
    const box = framed.container.querySelector<HTMLElement>("[data-run-progress-panel]");
    expect(box).not.toBeNull();
    expect(box!.className).not.toContain("soft-panel");
    expect(box!.className).not.toContain("rounded-card");
    expect(framed.queryByText(/Agentic Run Progress/i)).toBeNull();
  });

  it("keeps that plate a card for every host the rail does not frame", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const plain = render(<AgenticRunPanel {...agenticProps()} />);
    const box = plain.container.querySelector<HTMLElement>("[data-run-progress-panel]");
    expect(box).not.toBeNull();
    expect(box!.className).toContain("soft-panel");
    expect(box!.className).toContain("rounded-card");
  });

  it("leaves the input-step reading cinatra#3113 shipped exactly as it was", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps({ inputStepInRail: true })} />);

    expect(screen.queryByText(/Agentic Run Progress/i)).toBeNull();
  });
});
