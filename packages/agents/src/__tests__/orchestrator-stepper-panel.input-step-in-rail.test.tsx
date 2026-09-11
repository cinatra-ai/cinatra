// @vitest-environment jsdom
/**
 * THE STEP-LESS PANEL RETIRES FOR THE RUN'S FIRST STEP (cinatra#3068).
 *
 * The flow/orchestrator branch of the run page draws the same defect the
 * agentic branch does: a run whose approval policy fires no renderer gate has
 * `stepperSteps.length === 0`, so this panel returns a section titled "Agentic
 * Run Progress" with a status badge and no step list — over the agent's own
 * input form, before anything has run.
 *
 * Once the page's rail carries that step (`inputStepInRail`), the panel hands
 * the stage card over BARE, exactly as `embedMode` already does: the card is
 * the step's screen in the detail column, under the rail that names it. Every
 * other caller is untouched — the section, its title and its badge are drawn
 * exactly as before.
 *
 * Harness mirrors orchestrator-stepper-panel-completed-terminal.test.tsx.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/orchestrator-stepper-panel.input-step-in-rail.test.tsx
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

describe("OrchestratorStepperPanel — the step-less panel and the rail's input step", () => {
  it("draws NO Agentic Run Progress panel once the rail carries the input step", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps({ inputStepInRail: true })} />);

    expect(screen.queryByText(/Agentic Run Progress/i)).toBeNull();
  });

  it("still hands over the stage card — the step's screen, in the detail column", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    const view = render(
      <OrchestratorStepperPanel {...baseProps({ inputStepInRail: true })} />,
    );

    // The card the branch has always drawn is still there; only the section
    // heading over it is gone.
    expect(view.container.textContent).not.toBe("");
  });

  it("keeps the section, its title and its badge for every other caller", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);

    expect(screen.queryByText(/Agentic Run Progress/i)).not.toBeNull();
  });
});
