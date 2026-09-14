// @vitest-environment jsdom
/**
 * THE TWO READINGS THE RATIFIED DRAWING DRAWS FOR A FINISHED RUN
 * (cinatra#3149, item 1), pinned on the surfaces that actually draw them.
 *
 * Read at design main 033a697c3fede6920bac3d4c61e08def57436f02,
 * `specs/app-artifact-review.html`, section I:
 *
 *   1. THE FINISHED RUN NOBODY HAS TO DECIDE ANYTHING ABOUT — the
 *      `run-schedule-step-fired` example: the plate "Agentic Run Progress"
 *      beside `<span class="pill approved"><span class="dot"></span>completed
 *      </span>`, over the "Run complete" card. The word is the LOWERCASE
 *      `completed`, and the family is `approved`.
 *
 *   2. THE RUN WHOSE WORK IS WAITING ON A PERSON — the run-surface example
 *      paused on a review gate: the run detail IS the gate's own card, whose
 *      header reads "Review requested" beside
 *      `<span class="pill hold"><span class="dot"></span>Awaiting your
 *      decision</span>` — and NO "Agentic Run Progress" plate is drawn above
 *      it.
 *
 * WHAT THIS FILE REPLACED, AND WHY. An earlier pass on this branch read the
 * second drawing as a word for the run-progress PLATE: it gave
 * `runStatusPillStatus` / `runStatusBadgeLabel` an `outputGateOpen` argument so
 * the plate could read "Awaiting your decision" over a finished run whose
 * output still had an open gate. The drawing draws no plate at all in that
 * moment — the gate's own card IS the detail — and the product draws none
 * either: both run-detail hosts hand the column to the gate's card and never
 * reach the plate. That word was therefore a reading nothing in the product
 * could ever show, and it is withdrawn; `run-surface-status.ts` is back to the
 * API `main` carries. What stands in its place is this file: pins of the
 * readings the drawing DOES draw, on the mounts the run page actually makes.
 * They are PINS, not fixes — green on `main` before this change, and they must
 * stay green.
 *
 * THE WORD "Finished" IS NOT PINNED HERE. It appears in the drawing exactly
 * twice (lines 816 and 870 at the sha above), both times as the state pill of
 * the "What this run made" panel of section I.2 — the run's own LAST RAIL STEP,
 * drawn there with that section's `Done` rail entry. This branch builds no such
 * surface; it is pull request cinatra#3311's (issue #3029). Writing "Finished"
 * onto the run-progress plate would contradict the drawing's own
 * `run-schedule-step-fired` example, which the first case below pins.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-state-word-and-gate-header.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

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
    ownKeys: () => ["AlertCircle", "ArrowRight", "CalendarClock", "Clock", "default"],
    getOwnPropertyDescriptor: () => ({
      configurable: true,
      enumerable: true,
      value: StubIcon,
    }),
  });
});

// The gate card's conversational window mounts the shared `PromptField`, which
// pulls browser-only deps jsdom cannot load — stubbed exactly as the gate's own
// suites stub it, because what these cases read is the gate's HEADER.
vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: ({ placeholder }: { placeholder?: string }) => (
    <div data-testid="review-prompt-field">{placeholder}</div>
  ),
}));

vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: vi.fn(async () => []),
  sendRunWindowTurn: vi.fn(async () => ({ kind: "ok", entries: [] })),
}));

vi.mock("@/lib/cinatra-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  cinatraToast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/agents/run",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../orchestrator-actions", () => ({
  pauseRun: vi.fn(),
  resumeRun: vi.fn(),
  stopRun: vi.fn(),
  cancelOrchestratorAction: vi.fn(async () => ({ ok: true })),
  resumeStoppedOrchestratorAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../run-actions", () => ({
  getRunStatus: vi.fn(async () => ({ status: "completed" })),
  retryRun: vi.fn(),
  startRun: vi.fn(),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  startDevChildPreviewRun: vi.fn(async () => ({ ok: false })),
  buildSubmissionMapByStepIndex: vi.fn(async () => []),
  // The completion card reads its evidence at mount; these cases are about the
  // HEADER above it, so the read is answered flatly rather than left to reject.
  readRunOutputEvidence: vi.fn(async () => ({
    ok: true,
    outputs: [],
    items: [],
    transcriptHref: null,
    hasTranscript: false,
    hasStepResults: false,
    outputsUnavailable: false,
    unlinkableOutputs: 0,
  })),
}));

vi.mock("../run-recommendation-actions", () => ({
  decideRunRecommendation: vi.fn(),
  getRunRecommendationHoldStateAction: vi.fn(async () => ({ state: "none" })),
  decideRunRecommendationAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../run-name-actions", () => ({
  renameRun: vi.fn(),
  ensureOrCheckRunNameAction: vi.fn(async () => ({ ok: true, title: "Run 1" })),
}));

vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => ({ ok: true })),
  rejectReviewTask: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({})),
  getSkillsForAgentAction: vi.fn(async () => []),
}));

vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(() => new Promise<never>(() => {})),
  sendAgentBuilderMessage: vi.fn(async () => ({})),
}));

vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: (_runId: string, opts: { initialStatus?: string }) => ({
    status: opts?.initialStatus ?? "completed",
    interruptContext: null,
    messages: [],
    streamedText: "",
    presentationHint: null,
    dataPartFrames: [],
    isLive: false,
    error: null,
  }),
}));

vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));

/** The drawing's own words on the gate's header — measured as TEXT, because
 *  the gate header is not a `status-pill` and never was. */
const GATE_HEADER_WORDS = "Awaiting your decision";

/** Every run-progress plate in one render — the box the drawing does not draw
 *  above a gate. `[data-run-progress-panel]` is the agentic host's own marker;
 *  the stepper host's plate is named by its heading. */
function progressPlates(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-run-progress-panel]"));
}

function plateHeadings(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("h2")).filter((h) =>
    /Agentic Run Progress/i.test(h.textContent ?? ""),
  );
}

/** The plate's own pill, wherever the plate is drawn. */
function platePillText(container: HTMLElement): string | undefined {
  return container
    .querySelector<HTMLElement>('[data-slot="status-pill"]')
    ?.textContent?.trim();
}

function textIsOnScreen(container: HTMLElement, words: string): boolean {
  return (container.textContent ?? "").includes(words);
}

/** One answer per route: the run's seed route states the slot, the lifecycle
 *  resolve route states the gate is pending and undecided. */
function seedRoutes(slot: { ref: string | null; awaiting: boolean }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url =
        typeof input === "string"
          ? input
          : ((input as { url?: string })?.url ?? String(input));
      const body = url.includes("/api/lifecycle-views/resolve")
        ? {
            kind: "artifact_review_gate",
            state: { state: "pending", canDecide: true, canComment: true },
            body: null,
          }
        : { reviewGate: slot };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

beforeEach(() => {
  seedRoutes({ ref: null, awaiting: false });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

type StepperProps = import("../orchestrator-stepper-panel").OrchestratorStepperPanelProps;
type AgenticProps = import("../agentic-run-panel").AgenticRunPanelProps;

function stepperRun(overrides: Partial<StepperProps> = {}): StepperProps {
  return {
    runId: "run-3149",
    initialStatus: "completed",
    initialError: null,
    agUiEnabled: false as boolean | null,
    agentPackageName: "@cinatra-ai/blog-draft-writer-agent",
    inputParams: {},
    stepperSteps: [],
    agentId: "cinatra-ai/blog-draft-writer-agent",
    lgThreadId: null,
    templateId: "tmpl-3149",
    templateName: "Blog draft writer",
    ...overrides,
  };
}

function agenticRun(overrides: Partial<AgenticProps> = {}): AgenticProps {
  return {
    runId: "run-3149",
    initialStatus: "completed",
    initialError: null,
    initialMessages: [],
    agUiEnabled: false as boolean | null,
    agentPackageName: "@cinatra-ai/author-agent",
    agentId: "cinatra-ai/author-agent",
    inputParams: {},
    ...overrides,
  } as AgenticProps;
}

describe("the finished run nobody has to decide anything about (drawing reading 1)", () => {
  it("maps the drawing's own lowercase word onto the drawing's own pill family", async () => {
    const { runStatusPillStatus, runStatusBadgeLabel } = await import(
      "../run-surface-status"
    );

    expect(runStatusPillStatus("completed")).toBe("approved");
    expect(runStatusBadgeLabel("completed", null)).toBe("completed");
  });

  it("the agentic host's plate reads exactly `completed`", async () => {
    seedRoutes({ ref: null, awaiting: false });
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const { container } = render(<AgenticRunPanel {...agenticRun()} />);

    await waitFor(() => expect(progressPlates(container)).toHaveLength(1));
    expect(platePillText(container)).toBe("completed");
  });

  it("the stepper host's plate reads exactly `completed`", async () => {
    seedRoutes({ ref: null, awaiting: false });
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    const { container } = render(
      <OrchestratorStepperPanel
        {...stepperRun({ initialReviewGate: { ref: null, awaiting: false } })}
      />,
    );

    await waitFor(() => expect(plateHeadings(container)).toHaveLength(1));
    expect(platePillText(container)).toBe("completed");
  });
});

describe("the run whose work is waiting on a person (drawing reading 2)", () => {
  it("the agentic host draws the gate's own header, and no plate above it", async () => {
    seedRoutes({ ref: "gate-ref-3149", awaiting: true });
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const { container } = render(
      <AgenticRunPanel
        {...agenticRun({ initialReviewGate: { ref: "gate-ref-3149", awaiting: true } })}
      />,
    );

    await waitFor(() =>
      expect(container.querySelector('[data-run-review-slot="review"]')).not.toBeNull(),
    );
    // The words the drawing gives this instant — on the GATE's header, which is
    // where the drawing puts them.
    await waitFor(() => expect(textIsOnScreen(container, GATE_HEADER_WORDS)).toBe(true));
    // And the box the drawing does not draw over it.
    expect(progressPlates(container)).toHaveLength(0);
    expect(plateHeadings(container)).toHaveLength(0);
  });

  it("the stepper host draws the gate's own header, and no plate above it", async () => {
    // The run page's own mount for a run whose detail the rail frames
    // (`railDrawsTheFrame`, `instance-screens.tsx`) — the framing every run
    // with a gate step is drawn under.
    seedRoutes({ ref: "gate-ref-3149", awaiting: true });
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    const { container } = render(
      <OrchestratorStepperPanel
        {...stepperRun({
          initialReviewGate: { ref: "gate-ref-3149", awaiting: true },
          railDrawsTheFrame: true,
        })}
      />,
    );

    await waitFor(() => expect(textIsOnScreen(container, GATE_HEADER_WORDS)).toBe(true));
    expect(progressPlates(container)).toHaveLength(0);
    expect(plateHeadings(container)).toHaveLength(0);
  });

  it("the words are the GATE's, not a status pill's — no pill claims them", async () => {
    // The reading the withdrawn change had made: a `status-pill` carrying the
    // wait word. The gate's header is plain markup of its own, so a pill with
    // those words anywhere in this detail would be a second, invented reading.
    seedRoutes({ ref: "gate-ref-3149", awaiting: true });
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const { container } = render(
      <AgenticRunPanel
        {...agenticRun({ initialReviewGate: { ref: "gate-ref-3149", awaiting: true } })}
      />,
    );

    await waitFor(() => expect(textIsOnScreen(container, GATE_HEADER_WORDS)).toBe(true));
    const pillTexts = Array.from(
      container.querySelectorAll<HTMLElement>('[data-slot="status-pill"]'),
    ).map((el) => el.textContent?.trim());
    expect(pillTexts).not.toContain(GATE_HEADER_WORDS);
  });
});
