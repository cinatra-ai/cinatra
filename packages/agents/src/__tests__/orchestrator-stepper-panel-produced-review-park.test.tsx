// @vitest-environment jsdom
/**
 * THE RUN PAGE'S PARKED COLUMN (cinatra#3007, fix leg 6).
 *
 * `OrchestratorStepperPanel` draws the run page for a flow run, and its stage
 * card is chosen by a ladder of states. That ladder has no arm for a run parked
 * on the review of what it PRODUCED — cinatra#3007 holds such a run in
 * `pending_approval` and withholds the terminal write, and the row still carries
 * the interrupt of the setup question the person answered long ago. So the
 * ladder reaches the approval arm, hands that spent interrupt to the approval
 * card, and the card — which has nothing live to draw for a gate that is already
 * resolved — draws nothing at all.
 *
 * The fifth capture photographed the result on both themes: the step rail says
 * Step 1 settled and Review, and the column beside it is "an empty block with no
 * card, no spinner, no identity, no text — not an error state, but not a
 * placeholder either."
 *
 * These cases require the two halves the agentic panel already draws for the
 * same run, off the same shared reader: the quiet placeholder while the gate row
 * is still being minted, and the review card in the SAME column once it exists.
 * The third is the control that the ordinary approval pause — a live question,
 * no park — still draws its approval card exactly as it did.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/orchestrator-stepper-panel-produced-review-park.test.tsx
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

vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));

const readRunOutputEvidenceMock = vi.fn(async (args: { runId: string }) => {
  void args;
  return {
    ok: true as const,
    outputs: [] as { id: string; type: string; title: string }[],
    hasTranscript: false,
    hasStepResults: false,
  };
});

/** The row's answer to the slot reader — the ONLY carrier of the park. */
const rowSlot = vi.hoisted(() => ({
  value: { ref: null as string | null, awaiting: false, producedReviewPark: false },
}));

const RESOLVE_PENDING = {
  kind: "artifact_review_gate",
  state: { state: "pending", canDecide: true, canComment: true },
  body: null,
};

beforeEach(() => {
  streamState.status = "pending_approval";
  streamState.interruptContext = null;
  rowSlot.value = { ref: null, awaiting: false, producedReviewPark: false };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      const payload = url.includes("/api/agents/runs/")
        ? { reviewGate: rowSlot.value }
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

/** The setup question the person ALREADY answered, still on the row. */
const SPENT_SETUP_INTERRUPT = {
  xRenderer: "grouped-setup-form",
  reviewTaskId: "setup-run-3007",
  inputSchema: { type: "object", properties: {}, required: [] },
  currentValues: { stepNumber: 0 },
};

function baseProps(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    runId: "run-3007",
    initialStatus: "pending_approval",
    initialError: null,
    agUiEnabled: false as boolean | null,
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

const SLOT = '[data-run-review-slot]';
const PLACEHOLDER = '[data-conformance-id="review-gate-placeholder"]';
const REVIEW_CARD = '[data-conformance-id="review-gate-card"]';

describe("OrchestratorStepperPanel — a run parked on the review of what it produced", () => {
  it("draws the quiet placeholder card, not an empty column, while the gate row is still being minted", async () => {
    streamState.interruptContext = SPENT_SETUP_INTERRUPT;
    rowSlot.value = { ref: null, awaiting: true, producedReviewPark: true };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    const { container } = render(<OrchestratorStepperPanel {...baseProps()} />);

    const slot = await waitFor(
      () => {
        const el = container.querySelector(SLOT);
        if (!el) throw new Error("the column is still empty");
        return el as HTMLElement;
      },
      { timeout: 20_000 },
    );
    expect(slot.getAttribute("data-run-review-slot")).toBe("working");
    const placeholder = container.querySelector(PLACEHOLDER);
    expect(placeholder, "no placeholder was drawn in the parked column").not.toBeNull();
    // The drawing at the pin: the card frame and a spinning icon, and nothing
    // that names a status, reports a result or can be pressed.
    expect(placeholder!.querySelectorAll("svg.animate-spin").length).toBe(1);
    expect(slot.querySelectorAll("button").length).toBe(0);
  }, 40_000);

  it("swaps the review card into the SAME column once the gate row exists", async () => {
    streamState.interruptContext = SPENT_SETUP_INTERRUPT;
    rowSlot.value = { ref: "lcr-stepper-park-gate", awaiting: false, producedReviewPark: true };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    const { container } = render(<OrchestratorStepperPanel {...baseProps()} />);

    await waitFor(
      () => {
        if (!container.querySelector(REVIEW_CARD)) {
          throw new Error("the review card did not arrive in the stage column");
        }
      },
      { timeout: 20_000 },
    );
    expect(container.querySelector(PLACEHOLDER)).toBeNull();
  }, 40_000);

  it("leaves an ordinary approval pause exactly as it was", async () => {
    // The control: a LIVE question, and no park. The approval card is the
    // reading, and the park's arm must not have taken it. Asserted by what IS
    // drawn as well as by what is not — an assertion that only counts the
    // park's own DOM absent would be satisfied by the empty column this leg
    // exists to remove.
    streamState.interruptContext = SPENT_SETUP_INTERRUPT;
    rowSlot.value = { ref: null, awaiting: false, producedReviewPark: false };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    const { container } = render(<OrchestratorStepperPanel {...baseProps()} />);
    await waitFor(
      () => {
        if (container.querySelector(SLOT)) {
          throw new Error("the park's own card was drawn for a run that is not parked");
        }
      },
      { timeout: 5_000 },
    );
    expect(container.querySelector(PLACEHOLDER)).toBeNull();
    // The approval pause still draws its own card, with something on it.
    expect(
      container.querySelectorAll("button").length,
      "the ordinary approval pause lost every control it had",
    ).toBeGreaterThan(0);
  }, 30_000);

  it("does not hold a spinner nothing is reading for once the reader's belt has tripped", async () => {
    // THE BOUND ON THE PARK'S OWN ARM. This panel passes no liveness evidence
    // to its reader, by the reasoning stated at the reader: it is stream-driven
    // and a frame that never arrives proves nothing. So its failure belt is
    // terminal — and the last answer it ever got still says this run is parked.
    // An arm that drew the placeholder on "no gate row yet" alone would go on
    // spinning for the life of the tab after the reader had stopped looking for
    // the row that would end it. Once the reading stops the column falls back
    // to the ladder, which is the rendering this page had before this leg.
    streamState.interruptContext = SPENT_SETUP_INTERRUPT;
    rowSlot.value = { ref: null, awaiting: true, producedReviewPark: true };
    let down = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("/api/agents/runs/")) {
          if (down) throw new Error("transport down");
          return new Response(JSON.stringify({ reviewGate: rowSlot.value }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(RESOLVE_PENDING), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    const { container } = render(<OrchestratorStepperPanel {...baseProps()} />);

    // The park is read, and the quiet placeholder is held — the state the
    // other cases pin.
    await waitFor(
      () => {
        if (!container.querySelector(PLACEHOLDER)) {
          throw new Error("the park's placeholder was never drawn at all");
        }
      },
      { timeout: 20_000 },
    );

    // Then the route dies, and stays dead past the belt.
    down = true;
    await waitFor(
      () => {
        if (container.querySelector(PLACEHOLDER)) {
          throw new Error("a spinner is still being held with nobody reading for it");
        }
      },
      { timeout: 60_000 },
    );
  }, 90_000);
});
