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

// The ONE review card, stubbed: the assertion below is "this detail draws the
// review's own page", not a re-test of that card's drawing (it has its own
// suite). Only the resolved-review case mounts it.
vi.mock("../review-gate-card", () => ({
  LIFECYCLE_VIEW_SCHEMA_VERSION: 1,
  ReviewGateCard: () => <div data-testid="review-gate-card" />,
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

// cinatra#2997 — the run card holds its placeholder for ONE look before drawing
// a terminal rendering, so that a completion notice is never painted in front of
// a review that is about to open. These cases are about a run with NO review, so
// the look is answered with exactly that: the run's own seed route, saying the
// slot is empty. Without it the answer arrives as a transport failure instead,
// which is the same drawing by a slower route and makes the timing of these
// assertions depend on how loaded the machine is.
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

    // WAIT FOR THE CARD'S OWN COPY, not just its root. The card mounts with its
    // output evidence still in flight and names the outcome once it lands, and
    // since cinatra#2997 the card itself mounts one look later — so asserting
    // the copy the instant the root appears is a race this test used to win by
    // accident.
    await waitFor(() =>
      expect(screen.queryByText(/run finished without output/i)).not.toBeNull(),
    );
    expect(document.querySelector("[data-run-completion]")).not.toBeNull();
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

  it("does not point at a step rail that isn't rendered — zero stepperSteps with step-result evidence (coderabbit finding, cinatra#2519)", async () => {
    // hasStepResults: true with no linked outputs takes the "steps" branch of
    // resolveRunTerminalOutcome (outputRenderedBelow), which is exactly the
    // shape that used to render "select a completed step to review it" —
    // stepperSteps is empty here, so no step rail exists on the page to
    // select from.
    readRunOutputEvidenceMock.mockResolvedValueOnce({
      ok: true,
      outputs: [],
      hasTranscript: false,
      hasStepResults: true,
    });
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps({ stepperSteps: [] })} />);

    // The card mounts on the FIRST render (status is statically "completed"),
    // before the mocked evidence read resolves — waiting only for
    // data-run-completion would race the still-indeterminate copy. Wait for
    // the settled "no step list" text itself so the assertion below can never
    // observe the transient "could not be loaded here" state instead.
    await waitFor(() =>
      expect(
        screen.queryByText(/no step list here to select from/i),
      ).not.toBeNull(),
    );
    expect(screen.queryByText(/select a completed step/i)).toBeNull();
  });

  it("draws the resolved review's own page, and no completion card, when the run's last gate was a review (cinatra#3002 fix leg 1)", async () => {
    // THE READING THE DRAWING GIVES, pinned so it cannot drift silently.
    //
    // The first proof round measured that [data-run-completion] never mounts on
    // a real completed run whose review gates were decided: the run's review
    // slot still holds the last resolved gate, so this branch draws that gate's
    // card. The ratified drawing of the run surface settles that this is
    // right — "One page per gate — the step's own card, and nothing else.
    // Selecting a step opens that step's page in the run detail, and the page
    // carries the one card of the step it belongs to", and "two cards are
    // never stacked in one detail" — so a completion notice is never
    // stacked over a review's own page.
    //
    // What the drawing gives a finished run INSTEAD is a step of its own:
    // "A finished run says what it made. The rail's last entry is the run's own
    // record, and its page lists the run's work". That entry does not exist on
    // this surface yet, and it is not this card: naming it is this leg's
    // recorded deviation, and mounting the card here would be the wrong answer
    // to it.
    // No evidence is queued on purpose: the completion card is what reads the
    // run's output evidence, and the point of this case is that it never mounts.
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(
      <OrchestratorStepperPanel
        {...baseProps({
          initialReviewGate: { ref: "card-ref-resolved-review", awaiting: false },
        })}
      />,
    );

    await waitFor(() =>
      expect(screen.queryByTestId("review-gate-card")).not.toBeNull(),
    );
    expect(document.querySelector("[data-run-completion]")).toBeNull();
    expect(screen.queryByText(/select a completed step/i)).toBeNull();
  });
});
