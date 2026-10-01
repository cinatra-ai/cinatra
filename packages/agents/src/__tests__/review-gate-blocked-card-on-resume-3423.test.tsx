// @vitest-environment jsdom
/**
 * A READER TAB THAT LOST THE RACE DRAWS THE CARD, NEVER AN EMPTY PANEL
 * (cinatra#3423).
 *
 * The tab that presses Continue and loses is answered: the decision road refuses
 * it with the typed no-longer-pending outcome and the panel draws the blocked
 * state from it (cinatra#3219 pinned that). The tab that was ASLEEP while the
 * gate was decided somewhere else is answered by nobody. It wakes holding a gate
 * that is gone, its own gate read comes back empty, and the surface had nothing
 * to draw for "parked, with no gate" — the reader sits in front of a region that
 * says nothing and never resolves. The issue measured exactly that, four times,
 * frozen and unfrozen.
 *
 * The ratified drawing fixes what is owed here (specs/app-lifecycle-cards.html
 * §IV): a card is "no longer open when the gate was already settled or the run
 * moved on, offering a refresh rather than letting a stale decision through",
 * and "a disabled one must never be silently dropped".
 *
 * So: on RESUME — a window focus, or the tab becoming visible again — a surface
 * that is still holding no gate draws the shipped blocked panel, through the
 * component's own conformance anchor and its ratified sentence. A tab that never
 * slept fires neither event and keeps its waiting state, so an ordinary flicker
 * of the gate context is never mistaken for a decided gate.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/review-gate-blocked-card-on-resume-3423.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";

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
    ownKeys: () => ["AlertCircle", "ArrowRight", "CircleX", "RotateCcw", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

vi.mock("@/lib/cinatra-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
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
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

vi.mock("../run-name-actions", () => ({
  ensureOrCheckRunNameAction: vi.fn(async () => ({ ok: true, title: "Run 1" })),
}));

vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => ({ ok: true })),
  rejectReviewTask: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));

// The gate this tab is holding, as the stream reports it. `null` is the run
// saying it is parked while this surface has no gate to draw — the reading a
// tab comes back to when the gate was decided somewhere else.
let interruptContext: {
  schema: Record<string, unknown>;
  xRenderer: string;
  values: Record<string, unknown>;
  reviewTaskId: string;
  fieldName?: string;
} | null = null;

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: (_runId: string, opts: { initialStatus?: string }) => ({
    status: opts?.initialStatus ?? "pending_approval",
    interruptContext,
    lifecycleInterrupt: null,
    messages: [],
    streamedText: "",
    presentationHint: null,
    dataPartFrames: [],
    isLive: true,
    error: null,
  }),
}));

afterEach(() => {
  cleanup();
  interruptContext = null;
  vi.clearAllMocks();
});

type PanelProps = import("../orchestrator-stepper-panel").OrchestratorStepperPanelProps;

function baseProps(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    runId: "run-3423",
    initialStatus: "pending_approval",
    initialError: null,
    agUiEnabled: true as boolean | null,
    agentPackageName: "@cinatra-review-fixture/lost-race",
    inputParams: {},
    stepperSteps: [
      { index: 1, stepNumber: 0, label: "Confirm", xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID },
    ],
    agentId: "cinatra-review-fixture/lost-race",
    lgThreadId: null,
    templateId: "tmpl-3423",
    templateName: "Lost race",
    ...overrides,
  };
}

const BLOCKED = '[data-conformance-id="review-gate-blocked"]';

const OPEN_GATE = {
  schema: { type: "object" },
  xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
  values: {},
  reviewTaskId: "task-raced",
};

describe("OrchestratorStepperPanel — the tab that slept through the decision", () => {
  it("draws the blocked card on resume, in place of a spinner that never resolves", async () => {
    // This tab IS holding the pending gate — the reader can see it and decide it.
    interruptContext = OPEN_GATE;

    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    const props = baseProps();
    const { rerender } = render(<OrchestratorStepperPanel {...props} />);
    expect(await screen.findByRole("button", { name: /continue/i })).not.toBeNull();

    // The gate is decided in the OTHER context. This surface's own read of it
    // comes back empty while the run still reads as parked.
    interruptContext = null;
    await act(async () => {
      rerender(<OrchestratorStepperPanel {...props} />);
    });

    // Before the reader comes back nothing is claimed — a live tab whose gate
    // context merely flickered must not be told its review is closed.
    expect(document.querySelector(BLOCKED)).toBeNull();

    // The reader comes back.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(document.querySelector(BLOCKED)).not.toBeNull());
    // The ratified sentence, from the shipped component — not restated copy.
    expect(screen.queryByText("This review is no longer open")).not.toBeNull();
    expect(
      document.querySelector(BLOCKED)?.getAttribute("data-blocked-reason"),
    ).toBe("no-longer-pending");
    // And a way back to the live gate, which is what the drawing owes this state.
    expect(screen.queryByRole("button", { name: /refresh/i })).not.toBeNull();
  });

  it("a tab whose gate is still open is left alone when the reader comes back", async () => {
    interruptContext = OPEN_GATE;

    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(document.querySelector(BLOCKED)).toBeNull();
    expect(await screen.findByRole("button", { name: /continue/i })).not.toBeNull();
  });

  it("a tab that never drew the gate keeps its waiting state — not-yet is not gone", async () => {
    // Every healthy first paint of a paused run holds NO context for a tick, and
    // the server synthesizes one for every paused run: null means "nothing yet",
    // never "already settled or the run moved on". The settled card must not be
    // drawn over a gate that has simply not arrived.
    interruptContext = null;

    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(document.querySelector(BLOCKED)).toBeNull();
  });

  it("a hidden tab is not told anything — the read happens on RESUME", async () => {
    interruptContext = OPEN_GATE;
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    const props = baseProps();
    const { rerender } = render(<OrchestratorStepperPanel {...props} />);
    expect(await screen.findByRole("button", { name: /continue/i })).not.toBeNull();

    interruptContext = null;
    await act(async () => {
      rerender(<OrchestratorStepperPanel {...props} />);
    });

    const hidden = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden" as DocumentVisibilityState);

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(document.querySelector(BLOCKED)).toBeNull();

    hidden.mockReturnValue("visible" as DocumentVisibilityState);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(document.querySelector(BLOCKED)).not.toBeNull());
    hidden.mockRestore();
  });
});

// The run page's own panel draws the same state on the same road, MEASURED
// BY RENDERING IT, next door in
// review-gate-blocked-card-agentic-panel-3423.test.tsx. It needs a different
// mock set (the stubs in this file are the stepper's), so it lives in its own
// file rather than being asserted here as source text.
