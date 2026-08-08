// @vitest-environment jsdom
/**
 * OrchestratorStepperPanel — terminal `completed` stage card (cinatra#2482).
 *
 * THE dead end the issue reports. A `completed` run drives
 * `activeStep = stepperSteps.length + 1`, so the stepper marks every step
 * complete — and the stage-card branch was literally `stageCard = null` for
 * every terminal status the earlier branches had not claimed. `failed` and
 * `stopped` had claimed theirs (FailedCard / CancelledCard), so `completed`
 * fell into the null: a frozen "Step 1 completed" with an empty right pane, no
 * output and no way forward.
 *
 * This suite mounts the real panel and locks:
 *
 *   1. a `completed` run renders the completion card, not nothing;
 *   2. a produced output is linked from it;
 *   3. `failed` still gets FailedCard and `stopped` still gets CancelledCard —
 *      the completion card must not steal or double-render either;
 *   4. a live run still gets the spinner.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/orchestrator-stepper-panel-completed-terminal.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

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

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("../orchestrator-actions", () => ({
  cancelOrchestratorAction: vi.fn(async () => ({ ok: true })),
  resumeStoppedOrchestratorAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../run-actions", () => ({
  startDevChildPreviewRun: vi.fn(async () => ({ ok: false })),
  buildSubmissionMapByStepIndex: vi.fn(async () => []),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  readRunOutputEvidence: (args: { runId: string }) => readRunOutputEvidenceMock(args),
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

// The card's "Start new run" is the REAL StartNewRunButton: the route-graph
// ratchet fold put both in run-completion-affordances.tsx, so stubbing the
// button would stub out the card under test. Its router is already mocked
// above, and its action rides the mocked ../run-actions.
type EvidenceResult =
  | { ok: true; outputs: { id: string; type: string; title: string }[]; hasTranscript: boolean; hasStepResults: boolean }
  | { ok: false; error: string };

const readRunOutputEvidenceMock = vi.fn(
  async (args: { runId: string }): Promise<EvidenceResult> => {
    void args;
    return { ok: true, outputs: [], hasTranscript: false, hasStepResults: false };
  },
);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

type PanelProps = import("../orchestrator-stepper-panel").OrchestratorStepperPanelProps;

function baseProps(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    runId: "run-2482",
    initialStatus: "completed",
    initialError: null,
    agUiEnabled: false as boolean | null,
    agentPackageName: "@cinatra-ai/blog-draft-writer-agent",
    inputParams: {},
    stepperSteps: [
      { index: 1, stepNumber: 0, label: "Setup", xRenderer: "grouped-setup-form" },
    ],
    agentId: "cinatra-ai/blog-draft-writer-agent",
    lgThreadId: null,
    templateId: "tmpl-2482",
    templateName: "Blog draft writer",
    ...overrides,
  };
}

describe("OrchestratorStepperPanel — terminal completed stage card (cinatra#2482)", () => {
  it("renders the completion card where a completed run used to render nothing", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);

    await waitFor(() =>
      expect(document.querySelector("[data-run-completion]")).not.toBeNull(),
    );
    expect(screen.queryByText(/run finished without output/i)).not.toBeNull();
    expect(screen.queryByRole("button", { name: /start new run/i })).not.toBeNull();
  });

  it("links a produced output from the finished run", async () => {
    readRunOutputEvidenceMock.mockResolvedValueOnce({
      ok: true,
      outputs: [{ id: "obj-draft", type: "blog_post", title: "The draft" }],
      hasTranscript: false,
      hasStepResults: false,
    });
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);

    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "The draft" })).not.toBeNull(),
    );
    expect(
      screen.getByRole("link", { name: "The draft" }).getAttribute("href"),
    ).toBe("/artifacts/obj-draft");
  });

  it("leaves the failed run to FailedCard — the completion card never steals it", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(
      <OrchestratorStepperPanel
        {...baseProps({ initialStatus: "failed", initialError: "WayFlow task failed" })}
      />,
    );

    expect(screen.queryByText(/run failed/i)).not.toBeNull();
    expect(document.querySelector("[data-run-completion]")).toBeNull();
    expect(readRunOutputEvidenceMock).not.toHaveBeenCalled();
  });

  it("leaves the stopped run to CancelledCard", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps({ initialStatus: "stopped" })} />);

    expect(screen.queryByText(/run stopped/i)).not.toBeNull();
    expect(document.querySelector("[data-run-completion]")).toBeNull();
  });

  it("leaves a live run to the spinner", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps({ initialStatus: "running" })} />);

    expect(document.querySelector("[data-run-completion]")).toBeNull();
    expect(readRunOutputEvidenceMock).not.toHaveBeenCalled();
  });
});
