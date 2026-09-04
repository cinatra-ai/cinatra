// @vitest-environment jsdom
/**
 * cinatra#3219 — convergence round: the blocked reading must actually REACH
 * the screen, and must not outlive the gate it belongs to.
 *
 * Two defects the source-text suite could not see, because it counted call
 * sites instead of rendering:
 *
 *   1. `handleContinue` and the grouped-setup submit both call `onApproved?.()`
 *      BEFORE awaiting the action. The parent answers with
 *      `setAwaitingNextStep(true)`, and the approval card is rendered only
 *      `!awaitingNextStep` — so by the time the blocked outcome comes back the
 *      card is unmounted and `setGateBlocked` paints nothing. The reader is
 *      left on the optimistic spinner, which is the same silent dead end
 *      #3219 filed, minus the framework string.
 *
 *   2. The blocked state was cleared on the BUFFER key (xRenderer + fieldName),
 *      which is not gate identity: a following gate can carry a new
 *      `reviewTaskId` under the same renderer with no field name, and the
 *      blocked panel would then cover a gate that is genuinely open.
 *
 * Both are asserted here against the rendered DOM, through the shipped
 * component's own conformance anchor (`review-gate-blocked`) and the ratified
 * sentence "This review is no longer open".
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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

// The gate refuses the way the SERVER now reports it: a returned, typed,
// serializable outcome — never a thrown message.
const approveReviewTask = vi.fn(async () => ({
  ok: false as const,
  blocked: "no-longer-pending" as const,
}));
vi.mock("../hitl-actions", () => ({
  approveReviewTask: (...args: unknown[]) =>
    (approveReviewTask as unknown as (...a: unknown[]) => Promise<unknown>)(...args),
}));

vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));

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
    runId: "run-3219",
    initialStatus: "pending_approval",
    initialError: null,
    agUiEnabled: true as boolean | null,
    agentPackageName: "@cinatra-review-fixture/stale-gate",
    inputParams: {},
    stepperSteps: [
      { index: 1, stepNumber: 0, label: "Confirm", xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID },
    ],
    agentId: "cinatra-review-fixture/stale-gate",
    lgThreadId: null,
    templateId: "tmpl-3219",
    templateName: "Stale gate",
    ...overrides,
  };
}

const BLOCKED = '[data-conformance-id="review-gate-blocked"]';

function gateContext(reviewTaskId: string) {
  return {
    schema: { type: "object" },
    xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
    values: {},
    reviewTaskId,
  };
}

describe("OrchestratorStepperPanel — the blocked reading reaches the screen (cinatra#3219)", () => {
  it("draws the shipped blocked panel after the optimistic Continue, not the spinner", async () => {
    interruptContext = gateContext("task-a");

    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);

    const button = await screen.findByRole("button", { name: /continue/i });
    fireEvent.click(button);

    await waitFor(() => expect(document.querySelector(BLOCKED)).not.toBeNull());
    // The ratified sentence, from the shipped component — not restated copy.
    expect(screen.queryByText("This review is no longer open")).not.toBeNull();
    expect(
      document.querySelector(BLOCKED)?.getAttribute("data-blocked-reason"),
    ).toBe("no-longer-pending");
    // Nothing was reported as approved, and no framework text is on screen.
    expect(screen.queryByText(/Server Components render/i)).toBeNull();
  });

  it("releases the block when the NEXT gate opens under the same renderer", async () => {
    interruptContext = gateContext("task-a");

    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    const { rerender } = render(<OrchestratorStepperPanel {...baseProps()} />);

    fireEvent.click(await screen.findByRole("button", { name: /continue/i }));
    await waitFor(() => expect(document.querySelector(BLOCKED)).not.toBeNull());

    // A NEW gate: same renderer, no field name — only the review-task id moves.
    interruptContext = gateContext("task-b");
    rerender(<OrchestratorStepperPanel {...baseProps()} />);

    await waitFor(() => expect(document.querySelector(BLOCKED)).toBeNull());
    expect(await screen.findByRole("button", { name: /continue/i })).not.toBeNull();
  });
});
