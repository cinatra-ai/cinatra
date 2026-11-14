// @vitest-environment jsdom
// THE IDEA STEP WAITS FOR A PICK ON THE RUN PAGE (cinatra#3035): `specs/app-artifact-review.html`
// I.1, "the Continue stays unavailable until a row is picked".
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { OrchestratorStepperPanel } from "../orchestrator-stepper-panel";

const stream = vi.hoisted(() => ({ interruptContext: null as unknown }));
const gateSend = vi.hoisted(() => ({ approveReviewTask: vi.fn(async (..._args: unknown[]) => ({ ok: true })) }));
vi.mock("lucide-react", () => {
  const StubIcon: React.FC = () => null;
  return new Proxy({} as Record<string, React.FC>, {
    get: (_target, prop) => (prop === "__esModule" ? true : prop === "then" || typeof prop === "symbol" ? undefined : StubIcon),
    has: () => true,
    ownKeys: () => ["AlertCircle", "ArrowRight", "Check", "Info", "Loader2", "Pause", "X", "default"],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});
vi.mock("@/lib/cinatra-toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/agents/cinatra-ai/blog-pipeline-agent/run-3035",
}));
const ok = vi.hoisted(() => async () => ({ ok: true }));
vi.mock("../orchestrator-actions", () => ({ cancelOrchestratorAction: vi.fn(ok), resumeStoppedOrchestratorAction: vi.fn(ok) }));
vi.mock("../run-actions", () => ({
  startDevChildPreviewRun: vi.fn(async () => ({ ok: false })),
  buildSubmissionMapByStepIndex: vi.fn(async () => []),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  readRunOutputEvidence: vi.fn(async () => ({ ok: true, outputs: [], hasTranscript: false, hasStepResults: false })),
}));
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: vi.fn(async () => ({ state: "none" })),
  confirmRunRecommendationAction: vi.fn(ok),
  skipRunRecommendationAction: vi.fn(ok),
}));
vi.mock("../run-name-actions", () => ({ ensureOrCheckRunNameAction: vi.fn(async () => ({ ok: true, title: "Run 1" })) }));
vi.mock("../hitl-actions", () => ({ approveReviewTask: (...args: unknown[]) => gateSend.approveReviewTask(...args) }));
vi.mock("../use-runtime-field-renderer-bindings", () => ({ useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }) }));
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: (_runId: string, opts: { initialStatus?: string }) => ({
    status: opts?.initialStatus ?? "pending_approval", interruptContext: stream.interruptContext, messages: [],
    streamedText: "", presentationHint: null, dataPartFrames: [], isLive: true, error: null,
  }),
}));

const IDEA_RENDERER_ID = "@cinatra-ai/blog-pipeline-agent:idea-selection";
type PanelProps = import("../orchestrator-stepper-panel").OrchestratorStepperPanelProps;

const SPINE: PanelProps["stepperSteps"] = [
  { index: 1, stepNumber: 1, label: "Select blog idea", xRenderer: IDEA_RENDERER_ID },
  { index: 2, stepNumber: 2, label: "Review blog draft", xRenderer: "@cinatra-ai/blog-pipeline-agent:draft-review" },
];

const IDEAS = [
  { artifactId: "idea-a", representationRevisionId: "rev-a", title: "Build an Audit Trail for Every AI Agent Run", text: "Build an Audit Trail for Every AI Agent Run\n\nWhat a run should keep." },
  { artifactId: "idea-b", representationRevisionId: "rev-b", title: "Why Reviews Belong Inside the Run", text: "Why Reviews Belong Inside the Run\n\nOne page per gate." },
];

/** The idea step, a mid-run gate drawn by the kind the default registration binds. */
const IDEA_GATE = {
  xRenderer: IDEA_RENDERER_ID,
  schema: {
    type: "object",
    "x-renderer": IDEA_RENDERER_ID,
    properties: { selectedIdeaJson: { type: "string", title: "Selected idea (JSON)" } },
  },
  values: { stepNumber: 1, ideas: IDEAS },
  reviewTaskId: "gate-idea-3035",
};

/** A mid-run gate of a kind that declares no hold: the schema-field floor over a text field. */
const HOLD_FREE_GATE = {
  xRenderer: "@cinatra-ai/hold-free-agent:output",
  schema: { type: "object", properties: { subject: { type: "string", title: "Subject" } } },
  values: { stepNumber: 1 },
  reviewTaskId: "gate-hold-free-3035",
};

function panelProps(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    runId: "run-3035", initialStatus: "pending_approval", initialError: null, agUiEnabled: false as boolean | null,
    agentPackageName: "@cinatra-ai/blog-pipeline-agent", inputParams: {}, stepperSteps: SPINE, agentId: "cinatra-ai/blog-pipeline-agent",
    lgThreadId: null, templateId: "tmpl-3035", templateName: "Blog Pipeline Agent", ...overrides,
  };
}

function continueButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter((b) =>
    /^continu/i.test((b.textContent ?? "").trim()),
  );
}

function checkedRadios(): Element[] {
  return Array.from(document.querySelectorAll('[role="radio"][aria-checked="true"]'));
}

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  stream.interruptContext = null;
  const body = JSON.stringify({ reviewGate: { ref: null, awaiting: false } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers: { "Content-Type": "application/json" } })));
});

afterEach(() => {
  cleanup();
  stream.interruptContext = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

// New test files restore what they mock, so the package's full run stays green.
afterAll(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("the run page's idea step opens with nothing picked and its Continue unavailable", () => {
  it("U2: one press on a row checks it, makes the Continue available, and sends that row's reference", async () => {
    stream.interruptContext = { ...IDEA_GATE };
    render(<OrchestratorStepperPanel {...panelProps()} />);
    await waitFor(() => expect(document.querySelectorAll('[role="radio"]').length).toBe(2));

    fireEvent.click(document.querySelectorAll<HTMLElement>('[role="radio"]')[0]!);

    await waitFor(() => expect(checkedRadios()).toHaveLength(1));
    const continues = continueButtons();
    expect(continues).toHaveLength(1);
    await waitFor(() => expect(continues[0]!.disabled).toBe(false));

    fireEvent.click(continues[0]!);
    await waitFor(() => expect(gateSend.approveReviewTask).toHaveBeenCalledTimes(1));
    const payload = gateSend.approveReviewTask.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload.userResponse).toBe(
      JSON.stringify({ artifactId: "idea-a", representationRevisionId: "rev-a" }),
    );
  });

  it("U1, U3: the gate opens with nothing picked and its Continue disabled; a later idea gate (another review task, the same renderer) does not inherit the pick", async () => {
    stream.interruptContext = { ...IDEA_GATE };
    const { rerender } = render(<OrchestratorStepperPanel {...panelProps()} />);
    await waitFor(() => expect(document.querySelectorAll('[role="radio"]').length).toBe(2));
    expect(checkedRadios()).toHaveLength(0);
    expect(continueButtons()).toHaveLength(1);
    expect(continueButtons()[0]!.disabled).toBe(true);
    fireEvent.click(document.querySelectorAll<HTMLElement>('[role="radio"]')[0]!);
    await waitFor(() => expect(continueButtons()[0]!.disabled).toBe(false));

    stream.interruptContext = { ...IDEA_GATE, reviewTaskId: "gate-idea-3035-next" };
    rerender(<OrchestratorStepperPanel {...panelProps()} />);
    await waitFor(() => expect(continueButtons()[0]!.disabled).toBe(true));
    expect(checkedRadios()).toHaveLength(0);
  });

  it("U0: a mid-run gate of a kind that declares no hold keeps its Continue enabled with nothing typed", async () => {
    stream.interruptContext = { ...HOLD_FREE_GATE };
    render(<OrchestratorStepperPanel {...panelProps()} />);
    await waitFor(() => expect(continueButtons().length).toBeGreaterThan(0));

    for (const button of continueButtons()) {
      expect(button.disabled).toBe(false);
    }
  });
});
