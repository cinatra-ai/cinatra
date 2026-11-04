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
 *     the gate's own field name, and each press sends exactly once.
 *
 * Harness mirrors orchestrator-stepper-panel-setup-continue-3532.test.tsx.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/orchestrator-stepper-panel-boolean-setup-continue-4310.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

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

const FIELD = "sendFollowUps";
const REVIEW_TASK_ID = "setup-run-4310";
const SCHEMA = { type: "boolean" };

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

  it("a press repeated while the first send is in flight sends once", async () => {
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
});
