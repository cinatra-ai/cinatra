// @vitest-environment jsdom
/**
 * THE RUN PAGE'S RAIL FOLLOWS THE PAUSED STEP AND OPENS IT FROM ITS OWN ENTRY
 * (cinatra#3035, epic #3023 W11).
 *
 * The ratified drawing, `specs/app-artifact-review.html` section I:
 *
 *   "The step the run is paused on is highlighted; steps already passed sit
 *    above it, steps still to come below."
 *   "The run detail. Selecting a step opens it on the right."
 *
 * Two departures of the fourth picture round are pinned here:
 *   (2) inside the run surface's frame the rail kept the passed idea step
 *       highlighted after a live advance to the brand-voice gate, because the
 *       frame's rail is server-rendered and nothing asked for a server render
 *       (R0, R1, R5). One advance asks for one render: a second run's first
 *       gate only seeds that run's own set (R11), and a review gate's advance
 *       is refreshed once, by the review rail's own hook (R12);
 *   (3) the step row the run is paused on selected nothing when pressed, so a
 *       reader who opened another step could not bring the paused step's card
 *       back from its own entry (R2, R6, R7, R8). Only a run waiting on a
 *       person opens its active row: a running run's active row is a step
 *       still being worked (R13). A pending gate standing in the marked step's
 *       place is that step's row, so no spine row opens (R9, R9b).
 *
 * The press leaves the meaning of `aria-current` and
 * `data-run-surface-rail-selected` as main states it (cinatra#3449,
 * cinatra#4095): "the current reached step", whatever the detail shows (R3).
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-page-paused-rail-3035.test.tsx
 */
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { ARTIFACT_REVIEW_REDIRECT_RENDERER_ID } from "../agent-builder-ids";
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
  approveReviewTask: vi.fn(async () => ({ ok: true })),
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

/** The gate card's own Continue, drawn whatever renderer the gate binds. */
function continueButtons(root: ParentNode = document): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>("button")).filter((b) =>
    /^continu/i.test((b.textContent ?? "").trim()),
  );
}

/** The server rail the run page builds for the pipeline once the idea step is answered. */
function railWithIdeaAnswered(gates: Parameters<typeof buildRunStepRail>[0]["gates"] = undefined) {
  return buildRunStepRail({
    templateSteps: SPINE.map((s) => ({ index: s.index, stepNumber: s.stepNumber, label: s.label })),
    submissions: [{ stepIndex: 1, answered: true }],
    ...(gates ? { gates } : {}),
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
    await waitFor(() => expect(continueButtons().length).toBeGreaterThan(0));
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

  it("R11: a second run's first gate seeds that run's own set and asks for no refresh", async () => {
    const framedRun = (runId: string) => (
      <RunSurfaceRailFrameProvider value={true}>
        <OrchestratorStepperPanel {...panelProps({ runId })} />
      </RunSurfaceRailFrameProvider>
    );
    stream.interruptContext = { ...IDEA_GATE };
    const view = render(framedRun("run-3035"));
    await waitFor(() => expect(continueButtons().length).toBeGreaterThan(0));

    stream.interruptContext = { ...BRAND_VOICE_GATE };
    view.rerender(framedRun("run-3035-next"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(nav.refresh).toHaveBeenCalledTimes(0);
  });

  it("R12: a review gate's advance inside the frame is refreshed once, not by both readers", async () => {
    const BASE = "wayflow-task-draft";
    const redirect = (reviewTaskId: string) => ({
      schema: { type: "object" },
      xRenderer: ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
      values: {
        reviewSurfaceUrl: `/agents/cinatra-ai/blog-pipeline-agent/run-3035/review/${encodeURIComponent(reviewTaskId)}`,
        reviewTaskId,
        targetCount: 1,
        agentSummary: "",
      },
      reviewTaskId,
    });
    const framedReview = () => (
      <RunSurfaceRailFrameProvider value={true}>
        <OrchestratorStepperPanel
          {...panelProps({
            // The server drew both artifacts' gates and marked the first current.
            initialReviewGate: {
              ref: null,
              awaiting: false,
              railReviewTaskIds: [BASE, `${BASE}#2`],
              railCurrentReviewTaskId: BASE,
            },
          })}
        />
      </RunSurfaceRailFrameProvider>
    );
    stream.interruptContext = redirect(BASE);
    const view = render(framedReview());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(nav.refresh).toHaveBeenCalledTimes(0);

    stream.interruptContext = redirect(`${BASE}#2`);
    view.rerender(framedReview());
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });

  it("R0: the same move outside the frame asks for no refresh", async () => {
    stream.interruptContext = { ...IDEA_GATE };
    const view = render(framed(false));
    await waitFor(() => expect(continueButtons().length).toBeGreaterThan(0));

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
      <RunStepRailPanel entries={rail.entries} activeOrdinal={rail.activeOrdinal} reviewHrefBase="" runPaused />,
    );
    const voiceTrigger = stepTrigger(container, "Pick the brand voice");
    expect(voiceTrigger.getAttribute("aria-selected")).toBe("true");
    expect(voiceTrigger.disabled).toBe(false);
    expect(stepRow(container, "Select blog idea").getAttribute("data-rail-status")).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Departure (3) — the paused step opens from its own entry.
// ---------------------------------------------------------------------------
describe("the paused step's own rail entry opens its card in the run detail (departure 3)", () => {
  function railInFrame(
    selected: "schedule" | "detail",
    select: (next: string) => void,
    rail = railWithIdeaAnswered(),
    runPaused = true,
  ) {
    return render(
      <RunStepSelectionProvider value={{ selected, select: select as never }}>
        <RunStepRailPanel
          entries={rail.entries}
          activeOrdinal={rail.activeOrdinal}
          reviewHrefBase=""
          runPaused={runPaused}
        />
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

  it("R7: Space on the active row selects the run detail too", () => {
    const select = vi.fn();
    const { container } = railInFrame("schedule", select);
    fireEvent.keyDown(stepTrigger(container, "Pick the brand voice"), { key: " " });
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith("detail");
  });

  it("R8: a passed row and a row still to come select nothing and stay out of the tab order", () => {
    const select = vi.fn();
    const { container } = railInFrame("schedule", select);
    for (const label of ["Select blog idea", "Review blog draft"]) {
      const trigger = stepTrigger(container, label);
      expect(trigger.tabIndex).toBe(-1);
      fireEvent.click(trigger);
      fireEvent.keyDown(trigger, { key: "Enter" });
    }
    expect(select).toHaveBeenCalledTimes(0);
  });

  it("R9: a pending review gate on the rail stands for the paused step, so the spine row opens nothing", () => {
    const select = vi.fn();
    const rail = railWithIdeaAnswered([
      {
        gateId: "gate-brand-voice",
        reviewTaskId: "task-brand-voice",
        status: "pending",
        disposition: null,
        createdAt: "2026-11-08T00:00:00Z",
      },
    ]);
    const { container } = railInFrame("schedule", select, rail);
    const voiceTrigger = stepTrigger(container, "Pick the brand voice");
    expect(voiceTrigger.tabIndex).toBe(-1);
    fireEvent.click(voiceTrigger);
    expect(select).toHaveBeenCalledTimes(0);
  });

  it("R9b: a pending gate standing in the marked step's place is that step's row, so no spine row opens", () => {
    const select = vi.fn();
    const rail = buildRunStepRail({
      templateSteps: SPINE.map((s) => ({
        index: s.index,
        stepNumber: s.stepNumber,
        label: s.label,
        ...(s.stepNumber === 2 ? { marksReview: true } : {}),
      })),
      submissions: [{ stepIndex: 1, answered: true }],
      gates: [
        {
          gateId: "gate-voice",
          reviewTaskId: "wayflow-task-voice",
          status: "pending",
          disposition: null,
          createdAt: "2026-11-08T00:00:00Z",
        },
      ],
    });
    // The folded branch: the gate takes the marked step's place and is active.
    expect(rail.entries.find((e) => e.key === "gate:wayflow-task-voice")).toMatchObject({ onStep: 2, ordinal: 2 });
    expect(rail.activeOrdinal).toBe(2);
    const { container } = railInFrame("schedule", select, rail);
    expect(() => stepRow(container, "Pick the brand voice")).toThrow();
    for (const label of ["Select blog idea", "Review blog draft", "Approve the LinkedIn post"]) {
      const trigger = stepTrigger(container, label);
      expect(trigger.tabIndex).toBe(-1);
      fireEvent.click(trigger);
      fireEvent.keyDown(trigger, { key: "Enter" });
    }
    expect(select).toHaveBeenCalledTimes(0);
  });

  it("R10: outside a frame the active row keeps the inert control it had", () => {
    const rail = railWithIdeaAnswered();
    const { container } = render(
      <RunStepRailPanel entries={rail.entries} activeOrdinal={rail.activeOrdinal} reviewHrefBase="" runPaused />,
    );
    expect(stepTrigger(container, "Pick the brand voice").tabIndex).toBe(-1);
  });

  it("R13: a running run's active row is a step being worked, not a pause: it opens nothing", () => {
    const select = vi.fn();
    const { container } = railInFrame("schedule", select, railWithIdeaAnswered(), false);
    const voiceTrigger = stepTrigger(container, "Pick the brand voice");
    expect(voiceTrigger.getAttribute("aria-selected")).toBe("true");
    expect(voiceTrigger.tabIndex).toBe(-1);
    fireEvent.click(voiceTrigger);
    fireEvent.keyDown(voiceTrigger, { key: "Enter" });
    fireEvent.keyDown(voiceTrigger, { key: " " });
    expect(select).toHaveBeenCalledTimes(0);
  });

  it("R3: aria-current and data-run-surface-rail-selected keep main's meaning, the current REACHED step, whatever the detail shows and after a press (cinatra#3449, cinatra#4095)", () => {
    // The builder reads the paused spine step, which has no answer yet, as
    // "upcoming": a step the run has not reached is not current (#4095). The
    // press opens the detail and marks nothing with either attribute.
    const readings: string[] = [];
    for (const selected of ["schedule", "detail"] as const) {
      const { container, unmount } = railInFrame(selected, vi.fn());
      const voiceTrigger = stepTrigger(container, "Pick the brand voice");
      fireEvent.click(voiceTrigger);
      expect(voiceTrigger.getAttribute("data-run-surface-rail-reached")).toBe("false");
      expect(voiceTrigger.hasAttribute("aria-current")).toBe(false);
      expect(voiceTrigger.getAttribute("data-run-surface-rail-selected")).toBe("false");
      readings.push(
        Array.from(container.querySelectorAll("[data-run-surface-rail-step]"))
          .map((row) => `${row.getAttribute("aria-current")}|${row.getAttribute("data-run-surface-rail-selected")}`)
          .join(","),
      );
      unmount();
    }
    expect(readings[0]).toBe(readings[1]);
    expect(readings[0]).not.toContain("step|");
  });

  it("R4: an answered-but-current reached row keeps main's current mark, and the press still opens the detail", () => {
    // A rail whose active entry IS reached (main #4095 reads it current): the
    // run is parked on a step whose answer is recorded and not yet passed.
    const select = vi.fn();
    const rail = buildRunStepRail({
      templateSteps: SPINE.map((s) => ({ index: s.index, stepNumber: s.stepNumber, label: s.label })),
      submissions: [{ stepIndex: 1, answered: true }],
    });
    const voice = rail.entries.find((e) => e.label === "Pick the brand voice")!;
    const entries = rail.entries.map((e) => (e === voice ? { ...e, status: "pending" as const } : e));
    const { container } = render(
      <RunStepSelectionProvider value={{ selected: "schedule", select: select as never }}>
        <RunStepRailPanel entries={entries} activeOrdinal={voice.ordinal} reviewHrefBase="" runPaused />
      </RunStepSelectionProvider>,
    );
    const voiceTrigger = stepTrigger(container, "Pick the brand voice");
    expect(voiceTrigger.getAttribute("aria-current")).toBe("step");
    expect(voiceTrigger.getAttribute("data-run-surface-rail-selected")).toBe("true");
    fireEvent.click(voiceTrigger);
    expect(select).toHaveBeenCalledWith("detail");
  });
});
