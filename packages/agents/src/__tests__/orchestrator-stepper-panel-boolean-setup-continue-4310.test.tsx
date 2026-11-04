// @vitest-environment jsdom
/**
 * cinatra#4310 — THE STEPPER'S PER-FIELD BOOLEAN QUESTION HAS A CONTINUE.
 *
 * A per-field setup gate for a boolean input is drawn by the schema-field
 * fallback, whose registry entry declares `drawsOwnSubmit: true`. The stepper
 * therefore stages nothing and draws no Continue of its own, and its setup-loop
 * branch hands every `onChange` straight to `submitSetupFieldPayload`. The
 * boolean branch used to call `onChange` on every tick, so the first tick sent
 * `true` and `false` could never be sent.
 *
 * What is pinned here, on this surface:
 *   - the gate draws exactly ONE Continue, beneath the box;
 *   - ticking and unticking the box sends nothing;
 *   - an untouched Continue sends `false`, a ticked one sends `true`, each under
 *     the gate's own field name, and each press sends exactly once, also when a
 *     second press lands in the same tick as the first.
 *
 * And on a MID-RUN gate (an `:output` renderer drawn by the schema floor) whose
 * schema is a boolean: the stepper's own outer Continue stays the gate's one
 * control, so the field draws no Continue beside it and the box writes through
 * to the gate as it did before cinatra#4310.
 *
 * Harness mirrors orchestrator-stepper-panel-setup-continue-3532.test.tsx.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/orchestrator-stepper-panel-boolean-setup-continue-4310.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { fieldRendererRegistry } from "../field-renderer-registry";
import { SchemaOnlyFloorRenderer } from "../schema-field-renderer";

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

const FIELD = "sendFollowUps";
const REVIEW_TASK_ID = "setup-run-4310";
const SCHEMA = { type: "boolean" };
/** A MID-RUN gate (`:output`) whose renderer is the schema floor. */
const MID_RUN_RENDERER_ID = "@cinatra-test/pack-agent:output";
const MID_RUN_TASK_ID = "lg-run-4310";

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
    runId: "run-4310",
    initialStatus: "pending_approval",
    initialError: null,
    agUiEnabled: false as boolean | null,
    agentPackageName: "@cinatra-ai/email-outreach-agent",
    inputParams: { offeringCompanyWebsite: "https://example.com" },
    stepperSteps: [
      { index: 1, stepNumber: 0, label: "Setup", xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID },
    ],
    agentId: "cinatra-ai/email-outreach-agent",
    lgThreadId: null,
    templateId: "tmpl-4310",
    templateName: "Email Outreach Agent",
  };
}

async function mountGate() {
  INTERRUPT = {
    schema: SCHEMA,
    xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
    // The run's other inputs: the stepper hands the field this envelope as its
    // `value`, and an object is not a ticked box.
    values: { offeringCompanyWebsite: "https://example.com" },
    reviewTaskId: REVIEW_TASK_ID,
    fieldName: FIELD,
  };
  const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
  return render(<OrchestratorStepperPanel {...baseProps()} />);
}

function box(): HTMLElement | null {
  return document.getElementById(`field-${FIELD}`);
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
  fieldRendererRegistry.register({
    id: MID_RUN_RENDERER_ID,
    priority: 100,
    condition: (_fieldName, schema) =>
      (schema as { "x-renderer"?: unknown })["x-renderer"] === MID_RUN_RENDERER_ID,
    renderer: SchemaOnlyFloorRenderer,
    drawsOwnSubmit: true,
  });
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

describe("OrchestratorStepperPanel — a per-field boolean setup question (cinatra#4310)", () => {
  it("draws exactly one Continue beneath the box, and the box opens clear", async () => {
    await mountGate();
    await waitFor(() => expect(box()).not.toBeNull());
    await waitFor(() => expect(continues()).toHaveLength(1));
    expect(box()!.getAttribute("aria-checked")).toBe("false");
  });

  it("ticking and unticking the box stages the answer and sends nothing", async () => {
    await mountGate();
    await waitFor(() => expect(box()).not.toBeNull());
    fireEvent.click(box()!);
    await waitFor(() => expect(box()!.getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(box()!);
    await waitFor(() => expect(box()!.getAttribute("aria-checked")).toBe("false"));
    await settle();
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });

  it("Continue with the box untouched sends false, once", async () => {
    await mountGate();
    await waitFor(() => expect(continues()).toHaveLength(1));
    fireEvent.click(continues()[0]!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    expect(hitlActions.approveReviewTask).toHaveBeenLastCalledWith(
      REVIEW_TASK_ID,
      { [FIELD]: false },
      FIELD,
      SCHEMA,
    );
    await settle();
    expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1);
  });

  it("Continue with the box ticked sends true, once", async () => {
    await mountGate();
    await waitFor(() => expect(box()).not.toBeNull());
    fireEvent.click(box()!);
    await waitFor(() => expect(box()!.getAttribute("aria-checked")).toBe("true"));
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    fireEvent.click(continues()[0]!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    expect(hitlActions.approveReviewTask).toHaveBeenLastCalledWith(
      REVIEW_TASK_ID,
      { [FIELD]: true },
      FIELD,
      SCHEMA,
    );
    await settle();
    expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1);
  });

  it("presses repeated while the first send is in flight (the Continue disabled) send once", async () => {
    let release: (v: { ok: true }) => void = () => {};
    hitlActions.approveReviewTask.mockImplementationOnce(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          release = resolve;
        }),
    );
    await mountGate();
    await waitFor(() => expect(continues()).toHaveLength(1));
    const press = continues()[0]!;
    fireEvent.click(press);
    fireEvent.click(press);
    fireEvent.click(press);
    await settle();
    expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1);
    release({ ok: true });
    await settle();
    expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1);
  });

  it("two presses in the same tick send once", async () => {
    let release: (v: { ok: true }) => void = () => {};
    hitlActions.approveReviewTask.mockImplementationOnce(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          release = resolve;
        }),
    );
    await mountGate();
    await waitFor(() => expect(continues()).toHaveLength(1));
    const press = continues()[0]!;
    act(() => {
      press.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      press.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1);
    release({ ok: true });
    await settle();
    expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1);
  });
});

describe("OrchestratorStepperPanel — a boolean asked on a mid-run gate (cinatra#4310)", () => {
  async function mountMidRunGate() {
    INTERRUPT = {
      schema: SCHEMA,
      xRenderer: MID_RUN_RENDERER_ID,
      values: {},
      reviewTaskId: MID_RUN_TASK_ID,
    };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    return render(<OrchestratorStepperPanel {...baseProps()} />);
  }

  function midRunBox(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[role="checkbox"]');
  }

  it("draws exactly one Continue, the stepper's own, and none beside the box", async () => {
    await mountMidRunGate();
    await waitFor(() => expect(midRunBox()).not.toBeNull());
    await waitFor(() => expect(continues()).toHaveLength(1));
  });

  it("a tick sends nothing, and the one Continue sends the gate's approval once", async () => {
    await mountMidRunGate();
    await waitFor(() => expect(midRunBox()).not.toBeNull());
    fireEvent.click(midRunBox()!);
    await settle();
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    await waitFor(() => expect(continues()).toHaveLength(1));
    fireEvent.click(continues()[0]!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    expect(hitlActions.approveReviewTask).toHaveBeenLastCalledWith(
      MID_RUN_TASK_ID,
      expect.objectContaining({ approved: true }),
      undefined,
      SCHEMA,
    );
    await settle();
    expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1);
  });
});
