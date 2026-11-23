// @vitest-environment jsdom
/**
 * cinatra#4150 -- a publishing FLOW run is served by OrchestratorStepperPanel on the run page (instance-screens.tsx,
 * `runDetailPanelKind`), and its publish gate parks the run in `pending_approval` with NO interrupt and no generic
 * review task (publish-decision-actions.ts, `holdRunAtPublishGate`). Before this mount the stepper's ladder fell
 * through to the waiting spinner and said "Processing response…" for as long as the decision stood open. The panel
 * draws the publish card in that place, by the agentic panel's rule; a run with no decision draws nothing extra.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

vi.mock("lucide-react", async () => {
  const actual = await vi.importActual<typeof import("lucide-react")>("lucide-react");
  const StubIcon: React.FC = () => null;
  return new Proxy({} as Record<string, React.FC>, {
    get: (_target, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      if (prop === "Loader2Icon") return actual.Loader2Icon;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["AlertCircle", "ArrowRight", "Check", "Info", "Loader2", "Pause", "X", "default"],
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
    ok: true as const,
    outputs: [] as { id: string; type: string; title: string }[],
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
vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));

const publishStateMock = vi.fn();
vi.mock("../publish-decision-card-actions", () => ({
  getPublishDecisionCardStateAction: (input: { runId: string }) => publishStateMock(input),
}));

const RUN_ID = "run-4150-flow";
const PENDING = {
  state: "pending",
  runId: RUN_ID,
  agentName: "Blog publisher",
  rows: [{ label: "Title", value: "Spring launch" }],
  mayDecide: true,
};

// The stream's reading, mutable so a case can move the run to another pause WITHOUT a status change.
const streamState = vi.hoisted(() => ({
  status: "pending_approval" as string,
  interruptContext: null as Record<string, unknown> | null,
}));
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

/** The run row the panel's row watch reads while the stream cannot speak. */
const row = vi.hoisted(() => ({ status: "pending_approval" as string }));

beforeEach(() => {
  publishStateMock.mockReset();
  streamState.status = "pending_approval";
  streamState.interruptContext = null;
  row.status = "pending_approval";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      const payload = url.includes("/api/agents/runs/")
        ? { status: row.status, reviewGate: { ref: null, awaiting: false, producedReviewPark: false } }
        : { kind: "artifact_review_gate", state: { state: "none" }, body: null };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
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
    runId: RUN_ID,
    initialStatus: "pending_approval",
    initialError: null,
    agUiEnabled: true,
    agentPackageName: "@example-vendor/publisher-agent",
    inputParams: {},
    stepperSteps: [{ index: 1, stepNumber: 0, label: "Setup", xRenderer: "grouped-setup-form" }],
    agentId: "example-vendor/publisher-agent",
    lgThreadId: null,
    templateId: "tmpl-4150",
    templateName: "Blog publisher",
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
  });
}

async function mountPanel(overrides: Partial<PanelProps> = {}) {
  const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
  const element = () => <OrchestratorStepperPanel {...baseProps(overrides)} />;
  const mounted = render(element());
  await flush();
  return { ...mounted, rerenderPanel: async () => { mounted.rerender(element()); await flush(); } };
}

const CARD = '[data-lifecycle-card="publish_decision"]';
const PROCESSING = "Processing response…";

describe("OrchestratorStepperPanel at a publish gate (cinatra#4150)", () => {
  it("a flow run at an open publish gate draws the card in place of the 'Processing response…' spinner", async () => {
    publishStateMock.mockImplementation(async () => PENDING);
    const { container } = await mountPanel();
    await waitFor(() => expect(container.querySelectorAll(CARD)).toHaveLength(1));
    const card = container.querySelector(CARD)!;
    expect(card.getAttribute("data-lifecycle-card-host")).toBe("run_card");
    expect(card.getAttribute("data-lifecycle-card-state")).toBe("pending");
    expect(container.textContent).toContain("Publish this?");
    expect(container.textContent).not.toContain(PROCESSING);
    // No generic approval surface beside it: no resume reading, no review placeholder.
    expect(container.querySelector('[data-run-review-slot]')).toBeNull();
    expect(publishStateMock).toHaveBeenCalledWith({ runId: RUN_ID });
  });

  it("the same, in embed mode and on the step-less branch: the card is the stage card wherever it is drawn", async () => {
    publishStateMock.mockImplementation(async () => PENDING);
    for (const overrides of [{ embedMode: true }, { stepperSteps: [] }] as Partial<PanelProps>[]) {
      const { container, unmount } = await mountPanel(overrides);
      await waitFor(() => expect(container.querySelectorAll(CARD)).toHaveLength(1));
      expect(container.textContent).not.toContain(PROCESSING);
      unmount();
    }
  });

  it("a flow run with NO publish decision draws nothing extra and keeps today's spinner", async () => {
    publishStateMock.mockImplementation(async () => ({ state: "none" }));
    const { container } = await mountPanel();
    await waitFor(() => expect(publishStateMock).toHaveBeenCalled());
    await flush();
    expect(container.querySelector(CARD)).toBeNull();
    expect(container.textContent).toContain(PROCESSING);
  });

  it("a FAILED read with no earlier answer keeps today's spinner: never an empty column", async () => {
    publishStateMock.mockImplementation(async () => {
      throw new Error("transient");
    });
    const { container } = await mountPanel();
    await waitFor(() => expect(publishStateMock).toHaveBeenCalled());
    await flush();
    expect(container.querySelector(CARD)).toBeNull();
    expect(container.textContent).toContain(PROCESSING);
  });

  it("a publish gate reached from an ORDINARY gate with no status change re-reads and swaps the card in", async () => {
    streamState.interruptContext = { schema: {}, xRenderer: "", values: {}, reviewTaskId: "task-ordinary-gate" };
    publishStateMock.mockImplementation(async () => ({ state: "none" }));
    const mounted = await mountPanel();
    await waitFor(() => expect(publishStateMock).toHaveBeenCalled());
    expect(mounted.container.querySelector(CARD)).toBeNull();

    streamState.interruptContext = null;
    publishStateMock.mockImplementation(async () => PENDING);
    await mounted.rerenderPanel();
    await waitFor(() => expect(mounted.container.querySelectorAll(CARD)).toHaveLength(1));
    expect(mounted.container.textContent).not.toContain(PROCESSING);
  });

  it("a publish gate opened LATER, after a `none` read between gates, with no status or signal change, draws the card on the read's next tick", async () => {
    // The review finding's timing: the ordinary gate clears and the read, taken while the run works between gates,
    // answers `none`. The stream stays `pending_approval` (a resume does not move it), so the row watch stays off and
    // nothing the panel hands the read changes when the publish decision opens afterwards.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      streamState.interruptContext = { schema: {}, xRenderer: "", values: {}, reviewTaskId: "task-ordinary-gate" };
      publishStateMock.mockImplementation(async () => ({ state: "none" }));
      const mounted = await mountPanel();
      streamState.interruptContext = null;
      await mounted.rerenderPanel();
      expect(mounted.container.querySelector(CARD)).toBeNull();
      const readsBetweenGates = publishStateMock.mock.calls.length;
      expect(readsBetweenGates).toBeGreaterThan(0);

      publishStateMock.mockImplementation(async () => PENDING);
      await mounted.rerenderPanel();
      expect(mounted.container.querySelector(CARD)).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100);
      });
      await flush();
      expect(mounted.container.querySelectorAll(CARD)).toHaveLength(1);
      expect(mounted.container.textContent).not.toContain(PROCESSING);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a park the stream never announces (stream stuck at running, the row says pending_approval) reaches the card", async () => {
    streamState.status = "running";
    row.status = "running";
    publishStateMock.mockImplementation(async () => ({ state: "none" }));
    const { container } = await mountPanel({ initialStatus: "running" });
    expect(container.querySelector(CARD)).toBeNull();

    row.status = "pending_approval";
    publishStateMock.mockImplementation(async () => PENDING);
    await waitFor(() => expect(container.querySelectorAll(CARD)).toHaveLength(1), { timeout: 15_000 });
    expect(container.textContent).not.toContain(PROCESSING);
  }, 30_000);

  // ONE HELD-RUN CARD (the conversation turn's and the agentic panel's rule, the same `publishGateIsOpen`). A run
  // parked at its publish gate is parked there and nowhere else, so a gate reading the stream still holds is stale
  // while the publish read positively answers `pending`: the publish card is the stage card, and no gate card beside it.
  const STALE_GATE = {
    schema: { type: "object", properties: { answer: { type: "string", title: "Your answer" } } },
    xRenderer: "",
    values: {},
    fieldName: "answer",
    reviewTaskId: "task-stale-question",
  };
  // What the gate's approval card draws for this gate (no renderer is registered for it in this suite).
  const GATE_CARD_TEXT = "Waiting for input";

  it("a STALE gate reading beside an OPEN publish decision: only the publish card is the stage card", async () => {
    streamState.interruptContext = STALE_GATE;
    publishStateMock.mockImplementation(async () => PENDING);
    const { container } = await mountPanel();
    await waitFor(() => expect(publishStateMock).toHaveBeenCalled());
    await flush();
    expect(container.querySelectorAll(CARD)).toHaveLength(1);
    expect(container.querySelector(CARD)!.getAttribute("data-lifecycle-card-state")).toBe("pending");
    // The stale gate's approval card is not drawn beside it.
    expect(container.textContent).not.toContain(GATE_CARD_TEXT);
    expect(container.textContent).not.toContain(PROCESSING);
  });

  it("the same gate reading with NO open publish decision keeps its gate card and draws no publish card", async () => {
    streamState.interruptContext = STALE_GATE;
    publishStateMock.mockImplementation(async () => ({ state: "none" }));
    const { container } = await mountPanel();
    await waitFor(() => expect(publishStateMock).toHaveBeenCalled());
    await flush();
    expect(container.querySelector(CARD)).toBeNull();
    expect(container.textContent).toContain(GATE_CARD_TEXT);
  });

  it("a SETTLED decision keeps its reading above what the run draws next, as on the agentic panel", async () => {
    streamState.status = "running";
    row.status = "running";
    publishStateMock.mockImplementation(async () => ({ ...PENDING, state: "approved", deciderName: "Ana" }));
    const { container } = await mountPanel({ initialStatus: "running" });
    await waitFor(() => expect(container.querySelector('[data-conformance-id="publish-card-approved"]')).not.toBeNull());
    expect(container.querySelectorAll(CARD)).toHaveLength(1);
  });
});
