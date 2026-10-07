// @vitest-environment jsdom
/**
 * THE IDEA STEP WAITS FOR A PICK, AND THE RUN PAGE'S RAIL FOLLOWS THE PAUSED
 * STEP AND OPENS IT FROM ITS OWN ENTRY (cinatra#3035, epic #3023 W11).
 *
 * The ratified drawing, `specs/app-artifact-review.html` section I:
 *
 *   "A page that opened with a row already chosen would settle the run's
 *    subject without being read, so the Continue stays unavailable until a row
 *    is picked."
 *   "The step the run is paused on is highlighted; steps already passed sit
 *    above it, steps still to come below."
 *   "every step, and every gate that pauses the run, is reached by selecting
 *    its entry on the rail and reads in the same run."
 *
 * THE FOURTH PICTURE ROUND counted three departures this file pins:
 *   (1) the idea step's Continue was available with no row picked (U0, U1, U2);
 *   (2) inside the run surface's frame the rail kept the passed idea step
 *       highlighted after a live advance to the brand-voice gate, because the
 *       frame's rail is server-rendered and nothing asked for a server render
 *       (R0, R1, R5);
 *   (3) the step row the run is paused on selected nothing when pressed, so a
 *       reader who opened another step could not bring the paused step's card
 *       back from its own entry (R2, R3).
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-page-idea-step-and-paused-rail-3035.test.tsx
 */
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import {
  RunStepSelectionProvider,
  RunSurfaceRailFrameProvider,
} from "../run-step-rail-extra-entry";
import { buildRunStepRail } from "../run-step-rail";
import { RunStepRailPanel } from "../run-step-rail-panel";
import { OrchestratorStepperPanel } from "../orchestrator-stepper-panel";

// --- Test doubles (the panel harness gate-card-alone-in-the-run-frame uses) ----

/** The live interrupt the mocked stream hands the panel, moved per test. */
const stream = vi.hoisted(() => ({ interruptContext: null as unknown }));
/** The router's refresh, the one call departure (2) asks for. */
const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
/** The gate submissions U2 measures. */
const gateSend = vi.hoisted(() => ({
  approveReviewTask: vi.fn(async (...args: unknown[]) => {
    void args;
    return { ok: true };
  }),
}));

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
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: nav.refresh }),
  usePathname: () => "/agents/cinatra-ai/blog-pipeline-agent/run-3035",
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
  approveReviewTask: (...args: unknown[]) => gateSend.approveReviewTask(...args),
}));

vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: (_runId: string, opts: { initialStatus?: string }) => ({
    status: opts?.initialStatus ?? "pending_approval",
    interruptContext: stream.interruptContext,
    messages: [],
    streamedText: "",
    presentationHint: null,
    dataPartFrames: [],
    isLive: true,
    error: null,
  }),
}));

// --- The pipeline's four spine steps and its two first gates ------------------

const IDEA_RENDERER_ID = "@cinatra-ai/blog-pipeline-agent:idea-selection";

type PanelProps = import("../orchestrator-stepper-panel").OrchestratorStepperPanelProps;

const SPINE: PanelProps["stepperSteps"] = [
  { index: 1, stepNumber: 1, label: "Select blog idea", xRenderer: IDEA_RENDERER_ID },
  { index: 2, stepNumber: 2, label: "Pick the brand voice", xRenderer: "@cinatra-ai/blog-pipeline-agent:brand-voice" },
  { index: 3, stepNumber: 3, label: "Review blog draft", xRenderer: "@cinatra-ai/blog-pipeline-agent:draft-review" },
  { index: 4, stepNumber: 4, label: "Approve the LinkedIn post", xRenderer: "@cinatra-ai/blog-pipeline-agent:linkedin-review" },
];

const IDEAS = [
  {
    artifactId: "idea-a",
    representationRevisionId: "rev-a",
    title: "Build an Audit Trail for Every AI Agent Run",
    text: "Build an Audit Trail for Every AI Agent Run\n\nWhat a run should keep.",
  },
  {
    artifactId: "idea-b",
    representationRevisionId: "rev-b",
    title: "Why Reviews Belong Inside the Run",
    text: "Why Reviews Belong Inside the Run\n\nOne page per gate.",
  },
  {
    artifactId: "idea-c",
    representationRevisionId: "rev-c",
    title: "The Rail Is the Run's Whole Lifecycle",
    text: "The Rail Is the Run's Whole Lifecycle\n\nPassed above, to come below.",
  },
];

/** Gate A: the idea step, a mid-run gate drawn by the kind the default registration binds. */
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

/** Gate B: the brand-voice step, another review task. */
const BRAND_VOICE_GATE = {
  xRenderer: "@cinatra-ai/blog-pipeline-agent:brand-voice",
  schema: {
    type: "object",
    properties: { brandVoice: { type: "string", title: "Brand voice" } },
  },
  values: { stepNumber: 2 },
  reviewTaskId: "gate-brand-voice-3035",
};

/**
 * A mid-run gate of a kind that declares no hold: the schema-field floor over a
 * text field, reached through a mid-run output id no binding claims.
 */
const HOLD_FREE_GATE = {
  xRenderer: "@cinatra-ai/hold-free-agent:output",
  schema: {
    type: "object",
    properties: { subject: { type: "string", title: "Subject" } },
  },
  values: { stepNumber: 1 },
  reviewTaskId: "gate-hold-free-3035",
};

function panelProps(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    runId: "run-3035",
    initialStatus: "pending_approval",
    initialError: null,
    agUiEnabled: false as boolean | null,
    agentPackageName: "@cinatra-ai/blog-pipeline-agent",
    inputParams: {},
    stepperSteps: SPINE,
    agentId: "cinatra-ai/blog-pipeline-agent",
    lgThreadId: null,
    templateId: "tmpl-3035",
    templateName: "Blog Pipeline Agent",
    ...overrides,
  };
}

function continueButtons(root: ParentNode = document): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>("button")).filter((b) =>
    /^continu/i.test((b.textContent ?? "").trim()),
  );
}

function checkedRadios(root: ParentNode = document): Element[] {
  return Array.from(root.querySelectorAll('[role="radio"][aria-checked="true"]'));
}

/** The server rail the run page builds for the pipeline once the idea step is answered. */
function railWithIdeaAnswered() {
  return buildRunStepRail({
    templateSteps: SPINE.map((s) => ({ index: s.index, stepNumber: s.stepNumber, label: s.label })),
    submissions: [{ stepIndex: 1, answered: true }],
  });
}

function stepTrigger(container: HTMLElement, label: string): HTMLButtonElement {
  const trigger = Array.from(
    container.querySelectorAll<HTMLButtonElement>('[data-slot="stepper-trigger"]'),
  ).find((b) => (b.textContent ?? "").includes(label));
  if (!trigger) throw new Error(`no rail row reads ${label}`);
  return trigger;
}

function stepRow(container: HTMLElement, label: string): HTMLElement {
  const row = Array.from(
    container.querySelectorAll<HTMLElement>('[data-rail-kind="step"]'),
  ).find((r) => (r.textContent ?? "").includes(label));
  if (!row) throw new Error(`no rail row reads ${label}`);
  return row;
}

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  stream.interruptContext = null;
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
  stream.interruptContext = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

// NEW TEST FILES RESTORE WHAT THEY MOCK: the module graph and every spy are
// handed back so the package's full run stays green with this file present.
afterAll(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Departure (1) — the idea step's Continue waits for a pick.
// ---------------------------------------------------------------------------
describe("the idea step opens with nothing picked and its Continue unavailable (departure 1)", () => {
  it("U1: the idea gate opens with zero checked radios and its Continue disabled", async () => {
    stream.interruptContext = { ...IDEA_GATE };
    render(<OrchestratorStepperPanel {...panelProps()} />);
    await waitFor(() => expect(document.querySelectorAll('[role="radio"]').length).toBe(3));

    expect(checkedRadios()).toHaveLength(0);
    const continues = continueButtons();
    expect(continues).toHaveLength(1);
    expect(continues[0]!.disabled).toBe(true);
  });

  it("U2: one press on a row checks it, makes the Continue available, and sends that row's reference", async () => {
    stream.interruptContext = { ...IDEA_GATE };
    render(<OrchestratorStepperPanel {...panelProps()} />);
    await waitFor(() => expect(document.querySelectorAll('[role="radio"]').length).toBe(3));

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

  it("U0: a mid-run gate of a kind that declares no hold keeps its Continue enabled with nothing typed", async () => {
    stream.interruptContext = { ...HOLD_FREE_GATE };
    render(<OrchestratorStepperPanel {...panelProps()} />);
    await waitFor(() => expect(continueButtons().length).toBeGreaterThan(0));

    for (const button of continueButtons()) {
      expect(button.disabled).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Departure (2) — the frame's rail is server-rendered, so a live advance asks
// for one server render.
// ---------------------------------------------------------------------------
describe("a live advance to a new gate asks the router for one server render inside the frame (departure 2)", () => {
  function framed(inFrame: boolean) {
    return (
      <RunSurfaceRailFrameProvider value={inFrame}>
        <OrchestratorStepperPanel {...panelProps()} />
      </RunSurfaceRailFrameProvider>
    );
  }

  it("R1: the stream moving from the idea gate to the brand-voice gate refreshes exactly once", async () => {
    stream.interruptContext = { ...IDEA_GATE };
    const view = render(framed(true));
    await waitFor(() => expect(document.querySelectorAll('[role="radio"]').length).toBe(3));
    expect(nav.refresh).toHaveBeenCalledTimes(0);

    stream.interruptContext = { ...BRAND_VOICE_GATE };
    view.rerender(framed(true));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalledTimes(1));

    // A null flicker, then the same gate again, asks for nothing more.
    stream.interruptContext = null;
    view.rerender(framed(true));
    stream.interruptContext = { ...BRAND_VOICE_GATE };
    view.rerender(framed(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });

  it("R0: the same move outside the frame asks for no refresh", async () => {
    stream.interruptContext = { ...IDEA_GATE };
    const view = render(framed(false));
    await waitFor(() => expect(document.querySelectorAll('[role="radio"]').length).toBe(3));

    stream.interruptContext = { ...BRAND_VOICE_GATE };
    view.rerender(framed(false));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(nav.refresh).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// The server rail's composition once the idea step is answered.
// ---------------------------------------------------------------------------
describe("the server rail marks the answered idea step passed and highlights the brand-voice step (R5)", () => {
  it("R5: buildRunStepRail and the mounted rail read the idea step completed and the brand-voice step active", () => {
    const rail = railWithIdeaAnswered();
    const idea = rail.entries.find((e) => e.label === "Select blog idea")!;
    const voice = rail.entries.find((e) => e.label === "Pick the brand voice")!;
    expect(idea.status).toBe("completed");
    expect(rail.activeOrdinal).toBe(voice.ordinal);

    const { container } = render(
      <RunStepRailPanel entries={rail.entries} activeOrdinal={rail.activeOrdinal} reviewHrefBase="" />,
    );
    const voiceTrigger = stepTrigger(container, "Pick the brand voice");
    expect(voiceTrigger.getAttribute("aria-selected")).toBe("true");
    expect(voiceTrigger.disabled).toBe(false);
    expect(stepRow(container, "Select blog idea").getAttribute("data-rail-status")).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Departure (3), part (a) — the paused step opens from its own entry.
// ---------------------------------------------------------------------------
describe("the paused step's own rail entry opens its card in the run detail (departure 3)", () => {
  function railInFrame(selected: "schedule" | "detail", select: (next: string) => void) {
    const rail = railWithIdeaAnswered();
    return render(
      <RunStepSelectionProvider value={{ selected, select: select as never }}>
        <RunStepRailPanel entries={rail.entries} activeOrdinal={rail.activeOrdinal} reviewHrefBase="" />
      </RunStepSelectionProvider>,
    );
  }

  it("R2: with Schedule open, the active row is reachable and one press selects the run detail", () => {
    const select = vi.fn();
    const { container } = railInFrame("schedule", select);
    const voiceTrigger = stepTrigger(container, "Pick the brand voice");
    expect(voiceTrigger.tabIndex).toBe(0);

    fireEvent.click(voiceTrigger);
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith("detail");
  });

  it("R6: Enter on the active row selects the run detail, and the arrow keys still move along the rail", () => {
    const select = vi.fn();
    const { container } = railInFrame("schedule", select);
    const voiceTrigger = stepTrigger(container, "Pick the brand voice");

    fireEvent.keyDown(voiceTrigger, { key: "Enter" });
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith("detail");

    voiceTrigger.focus();
    fireEvent.keyDown(voiceTrigger, { key: "ArrowUp" });
    expect(document.activeElement).toBe(stepTrigger(container, "Select blog idea"));
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("R3: with the detail open, exactly one row reads current, the active brand-voice row", () => {
    const { container } = railInFrame("detail", vi.fn());
    const current = Array.from(container.querySelectorAll('[aria-current="step"]'));
    expect(current).toHaveLength(1);
    expect(current[0]!.textContent).toContain("Pick the brand voice");
    const selected = Array.from(container.querySelectorAll('[data-run-surface-rail-selected="true"]'));
    expect(selected).toHaveLength(1);
    expect(selected[0]!.textContent).toContain("Pick the brand voice");
  });
});
