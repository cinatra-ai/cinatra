// @vitest-environment jsdom
/**
 * cinatra#4244 - THE NEXT INPUT GATE IS DRAWN ON THE OPEN RUN PAGE.
 *
 * The run page of a flow-typed agent mounts the orchestrator stepper. A WayFlow
 * InputMessageNode with no renderer of its own reaches it on the schema-field
 * fallback id with an object schema. The stepper read EVERY such gate as a bare
 * `{ approved }` confirmation and drew a Continue alone, so a gate that declares
 * fields of its own (the blog pipeline's "Pick the brand voice", declaring
 * `brandVoice`) never drew `#field-brandVoice`: the reader saw nothing to fill
 * in after the Continue on the gate before it, and after a reload as well.
 *
 * Pinned here, on the stepper, with no reload and no remount:
 *   - Continue on one gate, then the run parks on the next gate, which declares
 *     a field: the open page draws that field, with exactly one Continue;
 *   - a filled answer is sent as the approval with the field in it, and a
 *     single text field's text is also the WayFlow resume text;
 *   - a blank optional answer sends the approval the Continue-only card sent;
 *   - a bare `{ type: "object" }` confirmation still draws no field and its one
 *     Continue still sends `{ approved, approvedAt }`.
 *
 * Harness mirrors orchestrator-stepper-panel-boolean-setup-continue-4310.test.tsx.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/orchestrator-stepper-panel-next-input-gate-4244.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { fieldRendererRegistry } from "../field-renderer-registry";

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
    ownKeys: () => ["AlertCircle", "ArrowRight", "Check", "CheckIcon", "Info", "Loader2", "Pause", "X", "default"],
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
  decideRunRecommendationAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../run-name-actions", () => ({
  ensureOrCheckRunNameAction: vi.fn(async () => ({ ok: true, title: "Run 1" })),
}));

const hitlActions = vi.hoisted(() => ({
  approveReviewTask: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock("../hitl-actions", () => hitlActions);

vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));

/** The gate before: a bare WayFlow confirmation, nothing to fill. */
const CONFIRM_TASK_ID = "wayflow-task-confirm";
const CONFIRM_SCHEMA = { type: "object" };

/** The gate after: a WayFlow input gate that declares one optional text field. */
const BRAND_TASK_ID = "wayflow-task-brand";
const BRAND_FIELD = "brandVoice";
const BRAND_SCHEMA = {
  type: "object",
  properties: {
    brandVoice: {
      type: "string",
      title: "Brand voice",
      "x-multiline": true,
    },
  },
};

/** The live interrupt the mocked stream hands the panel. */
let INTERRUPT: Record<string, unknown> | null = null;

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: (_runId: string, opts: { initialStatus?: string }) => ({
    status: opts?.initialStatus ?? "pending_approval",
    interruptContext: INTERRUPT,
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
    runId: "run-4244",
    initialStatus: "pending_approval",
    initialError: null,
    agUiEnabled: false as boolean | null,
    agentPackageName: "@cinatra-ai/blog-pipeline-agent",
    inputParams: {},
    stepperSteps: [
      { index: 1, stepNumber: 0, label: "Setup", xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID },
    ],
    agentId: "cinatra-ai/blog-pipeline-agent",
    lgThreadId: null,
    templateId: "tmpl-4244",
    templateName: "Blog Pipeline Agent",
  };
}

function confirmGate(): Record<string, unknown> {
  return {
    schema: CONFIRM_SCHEMA,
    xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
    values: {},
    reviewTaskId: CONFIRM_TASK_ID,
  };
}

function brandVoiceGate(): Record<string, unknown> {
  return {
    schema: BRAND_SCHEMA,
    xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
    values: {},
    reviewTaskId: BRAND_TASK_ID,
  };
}

async function mount(gate: Record<string, unknown>) {
  INTERRUPT = gate;
  const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
  const view = render(<OrchestratorStepperPanel {...baseProps()} />);
  return { ...view, OrchestratorStepperPanel };
}

function brandVoiceField(): HTMLElement | null {
  return document.getElementById(`field-${BRAND_FIELD}`);
}

/** Every button on the page that reads as a Continue. */
function continues(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter((b) =>
    /Continue|Submitting|Continuing/.test(b.textContent ?? ""),
  );
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(() => {
  // NOTHING IN THIS FILE REACHES THE NETWORK.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
  );
  ensureDefaultFieldRenderersRegistered();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  INTERRUPT = null;
  vi.clearAllMocks();
  hitlActions.approveReviewTask.mockReset();
  hitlActions.approveReviewTask.mockResolvedValue({ ok: true as const });
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
});

describe("OrchestratorStepperPanel - the next input gate after a Continue (cinatra#4244)", () => {
  it("draws the next gate's field on the open page after Continue on the gate before, with no reload", async () => {
    const { rerender, OrchestratorStepperPanel } = await mount(confirmGate());
    await waitFor(() => expect(continues()).toHaveLength(1));
    expect(brandVoiceField()).toBeNull();

    fireEvent.click(continues()[0]!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    expect(hitlActions.approveReviewTask).toHaveBeenLastCalledWith(
      CONFIRM_TASK_ID,
      expect.objectContaining({ approved: true }),
      undefined,
      CONFIRM_SCHEMA,
    );

    // The run moves on and parks on its next gate; the stream hands the page
    // the new interrupt. The same mounted panel re-renders: nothing reloads.
    act(() => {
      INTERRUPT = brandVoiceGate();
      rerender(<OrchestratorStepperPanel {...baseProps()} />);
    });

    await waitFor(() => expect(brandVoiceField()).not.toBeNull());
    await waitFor(() => expect(continues()).toHaveLength(1));
  });

  it("sends a filled answer as the approval with the field in it, its text as the resume text, once", async () => {
    await mount(brandVoiceGate());
    await waitFor(() => expect(brandVoiceField()).not.toBeNull());
    fireEvent.change(brandVoiceField()!, { target: { value: "Warm and plain." } });
    await waitFor(() => expect(continues()).toHaveLength(1));
    fireEvent.click(continues()[0]!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    expect(hitlActions.approveReviewTask).toHaveBeenLastCalledWith(
      BRAND_TASK_ID,
      expect.objectContaining({
        [BRAND_FIELD]: "Warm and plain.",
        userResponse: "Warm and plain.",
        approved: true,
      }),
      undefined,
      BRAND_SCHEMA,
    );
    await settle();
    expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1);
  });

  it("sends a blank optional answer as the approval the Continue-only card sent", async () => {
    await mount(brandVoiceGate());
    await waitFor(() => expect(brandVoiceField()).not.toBeNull());
    await waitFor(() => expect(continues()).toHaveLength(1));
    fireEvent.click(continues()[0]!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const call = hitlActions.approveReviewTask.mock.calls[0] as unknown[];
    expect(call[0]).toBe(BRAND_TASK_ID);
    expect(Object.keys(call[1] as Record<string, unknown>).sort()).toEqual([
      "approved",
      "approvedAt",
    ]);
  });

  it("keeps a bare object confirmation a Continue alone, with no field", async () => {
    await mount(confirmGate());
    await waitFor(() => expect(continues()).toHaveLength(1));
    expect(document.querySelector('[id^="field-"]')).toBeNull();
    fireEvent.click(continues()[0]!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const call = hitlActions.approveReviewTask.mock.calls[0] as unknown[];
    expect(call[0]).toBe(CONFIRM_TASK_ID);
    expect(Object.keys(call[1] as Record<string, unknown>).sort()).toEqual([
      "approved",
      "approvedAt",
    ]);
  });
});
