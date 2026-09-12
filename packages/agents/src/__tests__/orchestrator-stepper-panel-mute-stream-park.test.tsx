// @vitest-environment jsdom
/**
 * THE RUN PAGE READS THE ROW WHEN ITS STREAM CANNOT SPEAK (cinatra#3007,
 * fix leg 9).
 *
 * cinatra#3046 established the rule and gave the reason: a run parked on its
 * produced output's review reaches no terminal status, so it emits no
 * RUN_FINISHED and no RUN_ERROR, and the stream's last word stays `running` for
 * as long as the park lasts. The conversation's panel resolves through that rule
 * because it has a tick of its own to read the row with. This panel had none, so
 * it took the stream's word raw — and the park's own pins beside this file all
 * set the stream to `pending_approval`, which is precisely the frame a parked
 * run never sends. The defect lived in the gap between the two.
 *
 * What it cost, measured on a real production boot by the eighth graded reading: the
 * run page never swapped its review card in, in EITHER run, across 899 s of
 * one-second polls on untouched pages, while the shared review-slot reader it
 * mounts took no look at all — that reader looks only under `completed` or the
 * parked status, and this page reported neither. The only thing that changed on
 * the page was the run's own step advance.
 *
 * So these cases run the park in the shape a park really has: the stream stuck
 * at `running` and silent from there on, and the ROW the only thing that says
 * the run has stopped.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/orchestrator-stepper-panel-mute-stream-park.test.tsx
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

vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => ({ ok: true })),
}));

/** The stream a parked run really leaves behind: its last word is `running`,
 *  and it says nothing at all from there on. */
const streamState = vi.hoisted(() => ({
  status: "running" as string,
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

vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));

/** The RUN ROW, which is the only thing that can say this run has stopped. */
const row = vi.hoisted(() => ({
  status: "running" as string,
  reviewGate: { ref: null as string | null, awaiting: false, producedReviewPark: false },
}));

const RESOLVE_PENDING = {
  kind: "artifact_review_gate",
  state: { state: "pending", canDecide: true, canComment: true },
  body: null,
};

beforeEach(() => {
  streamState.status = "running";
  streamState.interruptContext = null;
  row.status = "running";
  row.reviewGate = { ref: null, awaiting: false, producedReviewPark: false };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      const payload = url.includes("/api/agents/runs/")
        ? { status: row.status, reviewGate: row.reviewGate }
        : RESOLVE_PENDING;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
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
    runId: "run-3007-mute",
    initialStatus: "running",
    initialError: null,
    // The run page of a run dispatched with the stream on — which is every run
    // the product creates today.
    agUiEnabled: true as boolean | null,
    agentPackageName: "@cinatra-ai/blog-draft-writer-agent",
    inputParams: {},
    stepperSteps: [
      { index: 1, stepNumber: 0, label: "Setup", xRenderer: "grouped-setup-form" },
    ],
    agentId: "cinatra-ai/blog-draft-writer-agent",
    lgThreadId: null,
    templateId: "tmpl-3007",
    templateName: "Blog draft writer",
    ...overrides,
  };
}

const SLOT = "[data-run-review-slot]";
const PLACEHOLDER = '[data-conformance-id="review-gate-placeholder"]';
const REVIEW_CARD = '[data-conformance-id="review-gate-card"]';

describe("OrchestratorStepperPanel — the park behind a mute stream", () => {
  it("draws the quiet placeholder while the run is parked and the stream still says running", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    const { container } = render(<OrchestratorStepperPanel {...baseProps()} />);

    // The run parks. The stream announces terminal states and a park is not
    // one, so it says nothing; the row is the whole of the evidence.
    row.status = "pending_approval";
    row.reviewGate = { ref: null, awaiting: true, producedReviewPark: true };

    const slot = await waitFor(
      () => {
        const el = container.querySelector(SLOT);
        if (!el) throw new Error("the run page never drew a review slot at all");
        return el as HTMLElement;
      },
      { timeout: 25_000 },
    );
    expect(slot.getAttribute("data-run-review-slot")).toBe("working");
    const placeholder = container.querySelector(PLACEHOLDER);
    expect(placeholder, "no quiet placeholder was drawn on the parked run page").not.toBeNull();
    expect(placeholder!.querySelectorAll("svg.animate-spin").length).toBe(1);
    expect(slot.querySelectorAll("button").length).toBe(0);
  }, 45_000);

  it("swaps the review card into the same column once the gate row exists", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    const { container } = render(<OrchestratorStepperPanel {...baseProps()} />);

    row.status = "pending_approval";
    row.reviewGate = {
      ref: "lcr-mute-stream-park-gate",
      awaiting: false,
      producedReviewPark: true,
    };

    await waitFor(
      () => {
        if (!container.querySelector(REVIEW_CARD)) {
          throw new Error("the review card never arrived on the untouched run page");
        }
      },
      { timeout: 25_000 },
    );
    expect(container.querySelector(PLACEHOLDER)).toBeNull();
  }, 45_000);

  it("leaves a run the row agrees is still working exactly as it was", async () => {
    // The control: the row and the stream agree the run is executing, and no
    // review slot is drawn on it.
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    const { container } = render(<OrchestratorStepperPanel {...baseProps()} />);
    await waitFor(
      () => {
        if (container.querySelector(SLOT)) {
          throw new Error("a review slot was drawn for a run that is still working");
        }
      },
      { timeout: 5_000 },
    );
  }, 30_000);
});
