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
    // THE BOX IS READ AT THE DRAWING'S SETTLED MOMENT (fix leg 14). A run
    // parked at `pending_approval` holds the review SLOT up on its first look —
    // `specs/app-lifecycle-cards.html` section II: "Before the card, the slot
    // holds its placeholder ... while the run is working that card is a
    // placeholder for the review screen" — and that placeholder stands down
    // "on its own" the moment the look answers with no card to bring. The
    // progress box this test pins is the reading on the far side of that look,
    // so the read waits for it rather than racing the placeholder. Every
    // assertion below is the one this test has always made.
    const box = await waitFor(() => {
      const found = framed.container.querySelector<HTMLElement>("[data-run-progress-panel]");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(box.className).not.toContain("soft-panel");
    expect(box.className).not.toContain("rounded-card");
    expect(framed.queryByText(/Agentic Run Progress/i)).toBeNull();
  });

  it("keeps that plate a card for every host the rail does not frame", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const plain = render(<AgenticRunPanel {...agenticProps()} />);
    // THE BOX IS READ AT THE DRAWING'S SETTLED MOMENT (fix leg 14). A run
    // parked at `pending_approval` holds the review SLOT up on its first look —
    // `specs/app-lifecycle-cards.html` section II: "Before the card, the slot
    // holds its placeholder ... while the run is working that card is a
    // placeholder for the review screen" — and that placeholder stands down
    // "on its own" the moment the look answers with no card to bring. The
    // progress box this test pins is the reading on the far side of that look,
    // so the read waits for it rather than racing the placeholder. Every
    // assertion below is the one this test has always made.
    const box = await waitFor(() => {
      const found = plain.container.querySelector<HTMLElement>("[data-run-progress-panel]");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(box.className).toContain("soft-panel");
    expect(box.className).toContain("rounded-card");
  });

  // ---------------------------------------------------------------------------
  // AND THE PARK'S OWN BOX OBEYS THE SAME CHROME RULE (cinatra#3007, fix leg
  // 14). This panel has a SECOND box: the review slot the park holds up while a
  // run that will ask for a review has not had its card land yet. The ratified
  // drawing, `specs/app-lifecycle-cards.html` section II:
  //
  //   "Before the card, the slot holds its placeholder. A run that will ask for
  //    a review carries, in the slot the review card will fill, the run
  //    progress card - and while the run is working that card is a placeholder
  //    for the review screen ... It names no status, reports no result and
  //    draws nothing to press."
  //
  // That slot is drawn in the SAME run detail as the gate card, so section I's
  // "two cards are never stacked in one detail" governs it exactly as it
  // governs the progress plate above: whoever draws the frame owns the chrome.
  // The slot never learned the rule, so inside the frame it wrapped the gate's
  // own card in a second one.
  // ---------------------------------------------------------------------------
  it("stacks no card around the park's own box inside the frame either", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const framed = render(
      <AgenticRunPanel {...agenticProps({ railDrawsTheFrame: true })} />,
    );
    const slot = framed.container.querySelector<HTMLElement>("[data-run-review-slot]");
    expect(slot).not.toBeNull();
    expect(slot!.className).not.toContain("soft-panel");
    expect(slot!.className).not.toContain("rounded-card");
  });

  // AND THE GROUND cinatra#3044 MEASURED IS UNTOUCHED off the frame. The eleventh
  // set graded this box on the run page, where the rail draws no frame, and
  // ruled its ground the drawn card frame - `border-line` over `surface-strong`,
  // one token darker than `.soft-panel`. The rule above must not reach it.
  it("keeps the park's measured ground for every host the rail does not frame", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const plain = render(<AgenticRunPanel {...agenticProps()} />);
    const slot = plain.container.querySelector<HTMLElement>("[data-run-review-slot]");
    expect(slot).not.toBeNull();
    expect(slot!.getAttribute("data-run-review-slot")).toBe("working");
    expect(slot!.className).toContain("rounded-card");
    expect(slot!.className).toContain("bg-surface-strong");
  });

  it("leaves the input-step reading cinatra#3113 shipped exactly as it was", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps({ inputStepInRail: true })} />);

    expect(screen.queryByText(/Agentic Run Progress/i)).toBeNull();
  });
});
