// @vitest-environment jsdom
/**
 * THE RUN PAGE'S OTHER PANEL DRAWS A PENDING REVIEW ON A RUN THAT FAILED
 * (cinatra#3051, the sixth proof round).
 *
 * WHAT THE ROUND MEASURED. A run generated its output, its task then failed,
 * and six seconds later a review gate was minted PENDING on it. Neither the
 * conversation nor the app's own run page drew a review card for that gate.
 *
 * THE SIBLING PANEL WAS ALREADY ANSWERED. `agentic-run-panel` reads the
 * condition from the one shared place both run panels are supposed to read it
 * from (`inPlaceRunReviewRef`): the work is over, and for a run that ended any
 * way other than `completed` the gate still has to be OPEN. Its own suite pins
 * that (`agentic-run-panel.produced-then-failed-review.test.tsx`).
 *
 * THIS PANEL WAS NOT. It asks `status === "completed"` for the review, and its
 * FIRST branch is `status === "failed"`, so a produced-then-failed run reached
 * the failure card and the pending review was never drawn anywhere on the run
 * page. That is a projector hiding a pending gate, and it is what this suite
 * pins shut.
 *
 * The ratified drawing fixes the condition and it is not a status: "when the
 * run's output is generated, the placeholder becomes the Review requested
 * screen — the same slot, in the same turn", and "what holds a card back is the
 * reader, not the host".
 *
 * AND WHAT STILL HOLDS IT BACK is pinned beside it: a SETTLED gate never takes
 * the slot back from the run's own current reading, so a failed run whose gate
 * was already decided keeps its failure card.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/orchestrator-stepper-panel.produced-then-failed-review.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { ARTIFACT_REVIEW_REDIRECT_RENDERER_ID } from "../agent-builder-ids";

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
}));

vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));

// The ONE card, stubbed so the assertion is "this panel mounts THE review
// renderer with the run's own server-minted ref", not a re-test of the card's
// own drawing (which has its own suite).
const reviewCardViews: unknown[] = [];
vi.mock("../review-gate-card", () => ({
  LIFECYCLE_VIEW_SCHEMA_VERSION: 1,
  ReviewGateCard: (props: { view: unknown }) => {
    reviewCardViews.push(props.view);
    return <div data-testid="review-gate-card" />;
  },
}));

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: (_runId: string, opts: { initialStatus?: string }) => ({
    status: opts?.initialStatus ?? "failed",
    interruptContext: null,
    lifecycleInterrupt: null,
    messages: [],
    streamedText: "",
    presentationHint: null,
    dataPartFrames: [],
    isLive: false,
    error: null,
  }),
}));

afterEach(() => {
  cleanup();
  reviewCardViews.length = 0;
  vi.clearAllMocks();
});

type PanelProps = import("../orchestrator-stepper-panel").OrchestratorStepperPanelProps;

function baseProps(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    runId: "run-3051",
    initialStatus: "failed",
    initialError: "WayFlow task failed",
    agUiEnabled: true as boolean | null,
    agentPackageName: "@cinatra-review-fixture/marked-review-gate",
    inputParams: {},
    stepperSteps: [
      { index: 1, stepNumber: 0, label: "Setup", xRenderer: "grouped-setup-form" },
      {
        index: 2,
        stepNumber: 1,
        label: "Review",
        xRenderer: ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
      },
    ],
    agentId: "cinatra-review-fixture/marked-review-gate",
    lgThreadId: null,
    templateId: "tmpl-3051",
    templateName: "Marked review gate",
    ...overrides,
  };
}

const FAILURE_CARD = /run failed/i;

describe("the output was generated and the task then failed (cinatra#3051)", () => {
  it("draws the run's PENDING review, not only the failure card", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(
      <OrchestratorStepperPanel
        {...baseProps({
          initialReviewGate: {
            ref: "server-minted-ref",
            awaiting: false,
            pending: true,
          },
        })}
      />,
    );

    await waitFor(() =>
      expect(screen.queryByTestId("review-gate-card")).not.toBeNull(),
    );
    // The question the reader is owed takes the stage card.
    expect(screen.queryByText(FAILURE_CARD)).toBeNull();
    expect(reviewCardViews.length).toBeGreaterThan(0);
    for (const view of reviewCardViews) {
      expect(view).toMatchObject({
        viewType: "artifact_review_gate",
        ref: "server-minted-ref",
      });
    }
  });

  it("a SETTLED gate does not take the stage from the run's own failure reading", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(
      <OrchestratorStepperPanel
        {...baseProps({
          initialReviewGate: {
            ref: "server-minted-ref",
            awaiting: false,
            pending: false,
          },
        })}
      />,
    );

    await waitFor(() => expect(screen.queryByText(FAILURE_CARD)).not.toBeNull());
    expect(screen.queryByTestId("review-gate-card")).toBeNull();
  });

  it("a failed run with no gate at all keeps its failure reading", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(
      <OrchestratorStepperPanel
        {...baseProps({
          initialReviewGate: { ref: null, awaiting: false, pending: false },
        })}
      />,
    );

    await waitFor(() => expect(screen.queryByText(FAILURE_CARD)).not.toBeNull());
    expect(screen.queryByTestId("review-gate-card")).toBeNull();
  });
});
