// @vitest-environment jsdom
/**
 * THE RUN'S STATE WORD CLAIMS NO MORE THAN IS TRUE (cinatra#3149, item 1).
 *
 * WHAT THE RATIFIED DRAWING ACTUALLY SAYS, read at design main
 * 033a697c3fede6920bac3d4c61e08def57436f02, specs/app-artifact-review.html.
 * The drawing carries TWO readings of a run whose work is done, and they are
 * not the same reading:
 *
 *   1. THE FINISHED RUN NOBODY HAS TO DECIDE ANYTHING ABOUT — example
 *      `run-schedule-step-fired`: the run detail's header is
 *      "Agentic Run Progress" beside
 *      `<span class="pill approved"><span class="dot"></span>completed</span>`,
 *      over the completion card ("Run complete"). The word is the lowercase
 *      `completed`, and the family is `approved`.
 *
 *   2. THE RUN WHOSE WORK IS WAITING ON A PERSON — the review reading of the
 *      same section: the run detail's header is "Review requested" beside
 *      `<span class="pill hold"><span class="dot"></span>Awaiting your
 *      decision</span>`. A `hold` pill, and a word that names the wait.
 *
 * The defect this suite pins is the seam between them. A run reaches
 * `completed` and the shipped sweeper opens the review on what it produced —
 * `orchestrator-stepper-panel.tsx` says so in its own words at the terminal
 * branch: "a flow run reaches `completed` and the shipped sweeper opens the
 * review on what it produced". In that instant the detail column correctly
 * draws the gate's own card (item 2), but the header above it kept reading
 * reading 1's settled `approved / completed` — a run announcing itself
 * finished over a review nobody has decided yet. That is a state claiming more
 * than is true, and neither of the drawing's two readings draws it.
 *
 * WHAT IS **NOT** BUILT HERE, AND WHY. The brief for this change also asked
 * that the completed entry read the word "Finished". That word appears in the
 * drawing EXACTLY twice (lines 816 and 870 at the sha above), and both are the
 * state word of the "What this run made" panel of section I.2 — the run's own
 * LAST RAIL STEP, a surface this repository does not build at all (the
 * terminal branch of `orchestrator-stepper-panel.tsx` says as much: "an entry
 * this surface does not carry yet"). The header pill is drawn by the drawing
 * as lowercase `completed`, and case 1 below PINS that, because writing
 * "Finished" onto this pill would be a regression against the drawing's own
 * `run-schedule-step-fired` example. The word is a defect of the brief, not of
 * the code, and it is recorded rather than built.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-state-claims-no-more-than-is-true.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

/** The header plate's own pill, read out of ONE render's container. */
function headerPillText(container: HTMLElement): string | undefined {
  const heading = Array.from(container.querySelectorAll("h2")).find((h) =>
    /Agentic Run Progress/i.test(h.textContent ?? ""),
  );
  return heading?.parentElement
    ?.querySelector<HTMLElement>("span.rounded-full")
    ?.textContent?.trim();
}

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

vi.mock("@/lib/cinatra-toast", () => ({
  cinatraToast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/agents/run",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../orchestrator-actions", () => ({
  pauseRun: vi.fn(),
  resumeRun: vi.fn(),
  stopRun: vi.fn(),
}));

vi.mock("../run-actions", () => ({
  getRunStatus: vi.fn(async () => ({ status: "completed" })),
  retryRun: vi.fn(),
  startRun: vi.fn(),
  createAndTriggerRun: vi.fn(),
  // The completion card reads its evidence at mount; this suite is about the
  // HEADER above it, so the read is answered flatly rather than left to reject.
  readRunOutputEvidence: vi.fn(async () => ({ items: [], transcriptHref: null })),
}));

vi.mock("../run-recommendation-actions", () => ({
  decideRunRecommendation: vi.fn(),
}));

vi.mock("../run-name-actions", () => ({
  renameRun: vi.fn(),
}));

vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(),
  rejectReviewTask: vi.fn(),
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

beforeEach(() => {
  // The seed route answers exactly what each case's props already state, so no
  // case depends on a probe landing inside the render.
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

function completedRun(overrides: Partial<PanelProps> = {}): PanelProps {
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

describe("the run-state word, pinned against the drawing's two readings", () => {
  it("pins the drawing's own word for a finished run with nothing to decide", async () => {
    // Reading 1, verbatim from `run-schedule-step-fired`: the `approved`
    // family, the lowercase word `completed`. This case is a PIN, not a fix:
    // it is green before this change and must stay green after it, because the
    // brief's proposed word ("Finished") belongs to a different surface
    // entirely (see this file's header).
    const { runStatusPillStatus, runStatusBadgeLabel } = await import(
      "../run-surface-status"
    );

    expect(runStatusPillStatus("completed")).toBe("approved");
    expect(runStatusBadgeLabel("completed", null)).toBe("completed");
  });

  it("does not read a settled word while a gate on the run's output is open", async () => {
    // Reading 2: the run is done, its output opened a review, and nobody has
    // decided it. The drawing gives that instant a `hold` pill reading
    // "Awaiting your decision" — never the settled `approved / completed`.
    const { runStatusPillStatus, runStatusBadgeLabel } = await import(
      "../run-surface-status"
    );

    expect(runStatusPillStatus("completed", true)).toBe("hold");
    expect(runStatusBadgeLabel("completed", null, true)).toBe(
      "Awaiting your decision",
    );
  });

  it("leaves every other status untouched by the open-gate reading", async () => {
    // The open-gate reading is a statement about a TERMINAL run only. A run
    // that is still working is already drawn by its own status and must not be
    // re-labelled by a slot answer that arrived early.
    const { runStatusPillStatus, runStatusBadgeLabel } = await import(
      "../run-surface-status"
    );

    expect(runStatusPillStatus("running", true)).toBe("running");
    expect(runStatusPillStatus("failed", true)).toBe("failed");
    expect(runStatusBadgeLabel("running", null, true)).toBe("running");
  });
});

describe("the run detail's own header, on the host that draws it", () => {
  it("reads the settled word over a completed run with no open gate", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    const view = render(
      <OrchestratorStepperPanel
        {...completedRun({ initialReviewGate: { ref: null, awaiting: false } })}
      />,
    );

    expect(headerPillText(view.container)).toBe("completed");
  });

  it("does not flash the wait word at a finished run that has no gate at all", async () => {
    // THE NARROWING, PINNED. The slot hook holds a "the review may still be
    // opening" window that is true on the FIRST paint of every completed run
    // that arrived without a slot answer — the ordinary finished run
    // included. Reading the wait word there would put "Awaiting your decision"
    // in front of a reader for whom nothing is waiting. The header answers the
    // narrower question: is there a review that EXISTS and is undecided.
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    // No `initialReviewGate` at all — the mount that opens that window.
    const view = render(<OrchestratorStepperPanel {...completedRun()} />);

    expect(headerPillText(view.container)).toBeTruthy();
    expect(headerPillText(view.container)).not.toBe("Awaiting your decision");
  });

  it("does not announce a finished run over a review nobody has decided", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    const view = render(
      <OrchestratorStepperPanel
        {...completedRun({
          initialReviewGate: { ref: "gate-ref-3149", awaiting: true },
        })}
      />,
    );

    // The word the drawing gives this instant, and NOT the settled one.
    expect(headerPillText(view.container)).toBe("Awaiting your decision");
    expect(headerPillText(view.container)).not.toBe("completed");
  });
});
