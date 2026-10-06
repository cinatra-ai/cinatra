// @vitest-environment jsdom
/**
 * THE SAME FILL ON THE STEP-BY-STEP SCREEN (cinatra#2934, fix leg 13).
 *
 * The drawing, `specs/app-artifact-review.html` §X: "On a surface with a form,
 * the sentence names filling — and the button stays the person's. The window
 * fills the fields the person can see with what they asked for, and nothing is
 * submitted until they press the screen's own button".
 *
 * The orchestrator stepper mounts the same window (`surface: "step-by-step"`),
 * writes a fill that did not press into its buffer and its suggestion payload,
 * and hands the host's schema-field floor the whole values envelope for a
 * string field — the same road the run page takes. So the floor's own field
 * must show the placed words before any press here too.
 *
 * Harness: orchestrator-stepper-hitl-field-label.test.tsx (the real panel on a
 * live per-field setup gate, the default renderers registered), with the
 * window's server actions mocked as run-window-fill-through-drawn-panel mocks
 * them and its field driven through the same stand-in.
 *
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/stepper-window-fill-reaches-setup-field-2934.test.tsx
 */
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";

/** The round's own words. */
const W = "Why self-hosted upgrades take longer than planned";
const ASK_FILL = "Fill the idea with: Why self-hosted upgrades take longer than planned. Do not submit it.";

const windowActions = vi.hoisted(() => ({
  loadRunWindowConversation: vi.fn(),
  sendRunWindowTurn: vi.fn(),
}));
vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: (...a: unknown[]) => windowActions.loadRunWindowConversation(...a),
  sendRunWindowTurn: (...a: unknown[]) => windowActions.sendRunWindowTurn(...a),
}));

vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: (props: { onSubmit: (s: string) => Promise<void> }) => (
    <span
      role="button"
      tabIndex={0}
      data-testid="prompt-field"
      onClick={() => void props.onSubmit(ASK_FILL)}
    >
      PromptField
    </span>
  ),
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

const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
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

const hitlActions = vi.hoisted(() => ({
  approveReviewTask: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../hitl-actions", () => hitlActions);

vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: (_runId: string, opts: { initialStatus?: string }) => ({
    status: opts?.initialStatus ?? "pending_approval",
    interruptContext: {
      schema: {
        type: "string",
        "x-multiline": true,
        "x-placeholder": "Paste one idea, or type what this post should be about",
      },
      xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
      values: {},
      reviewTaskId: "setup-run-2934-step",
      fieldName: "idea",
    },
    messages: [],
    streamedText: "",
    presentationHint: null,
    dataPartFrames: [],
    isLive: true,
    error: null,
  }),
}));

type PanelProps = import("../orchestrator-stepper-panel").OrchestratorStepperPanelProps;

function baseProps(): PanelProps {
  return {
    runId: "run-2934-step",
    initialStatus: "pending_approval",
    initialError: null,
    agUiEnabled: false as boolean | null,
    agentPackageName: "@cinatra-ai/blog-draft-writer-agent",
    inputParams: {},
    stepperSteps: [
      { index: 1, stepNumber: 0, label: "Setup", xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID },
    ],
    agentId: "cinatra-ai/blog-draft-writer-agent",
    lgThreadId: null,
    templateId: "tmpl-2934-step",
    templateName: "Blog draft writer",
  };
}

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  windowActions.loadRunWindowConversation.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

afterAll(() => {
  for (const id of [
    "../run-window-actions",
    "@cinatra-ai/sdk-ui",
    "lucide-react",
    "@/lib/cinatra-toast",
    "next/navigation",
    "../orchestrator-actions",
    "../run-actions",
    "../run-recommendation-actions",
    "../run-name-actions",
    "../hitl-actions",
    "../use-runtime-field-renderer-bindings",
    "../use-ag-ui-run-stream",
  ]) {
    vi.doUnmock(id);
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("the step-by-step screen's setup field shows what the window placed (cinatra#2934)", () => {
  it("F3 — #field-idea holds the placed words before any press, and nothing is sent", async () => {
    windowActions.sendRunWindowTurn.mockResolvedValue({
      ok: true,
      entries: [
        { id: 1, role: "user", content: ASK_FILL },
        {
          id: 2,
          role: "assistant",
          content:
            "Placed in the fields on your screen. Nothing was submitted — press the button when you are ready.",
        },
      ],
      fills: [{ ref: "ref_1", values: { idea: W } }],
      acted: false,
    });
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);

    await waitFor(() => expect(document.querySelector("#field-idea")).not.toBeNull());
    await waitFor(() => expect(screen.queryByTestId("prompt-field")).not.toBeNull());
    const field = () => document.querySelector("#field-idea") as HTMLTextAreaElement;
    expect(field().value).toBe("");

    await act(async () => {
      fireEvent.click(screen.getByTestId("prompt-field"));
    });
    await waitFor(() => expect(windowActions.sendRunWindowTurn).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(document.querySelectorAll('[data-run-window-entry="assistant"]').length).toBe(1),
    );

    await waitFor(() => expect(field().value).toBe(W));
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });
});
