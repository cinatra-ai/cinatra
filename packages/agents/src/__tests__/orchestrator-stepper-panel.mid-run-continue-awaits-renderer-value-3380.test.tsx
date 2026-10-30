// @vitest-environment jsdom
/**
 * cinatra#3380 — THE STEPPER'S MID-RUN CONTINUE WAITS FOR THE VALUE ITS
 * RENDERER MUST PRODUCE.
 *
 * A `flow`-typed template's run page mounts this panel. A pick renderer on a
 * mid-run gate writes its answer only when the person picks, and the outer
 * Continue was available before that, so a press resumed the run with no
 * answer.
 *
 * What is pinned here, on the stepper's outer Continue of a mid-run gate:
 *   - a gate whose schema declares a property `"x-required": true` draws its
 *     Continue unavailable before the renderer has written that property, and a
 *     press sends nothing;
 *   - once the renderer writes it, the Continue is available and sends it;
 *   - a gate that declares no such property (the email gates' object-level
 *     `required: ["decision"]`) keeps its Continue available before any write.
 *
 * Harness mirrors orchestrator-stepper-panel-setup-continue-3532.test.tsx.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/orchestrator-stepper-panel.mid-run-continue-awaits-renderer-value-3380.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { Button } from "@/components/ui/button";
import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { fieldRendererRegistry } from "../field-renderer-registry";
import type { FieldRendererProps } from "../field-renderer-registry";

// --- Panel mount harness (mirrors orchestrator-stepper-hitl-field-label) ---

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

/** The live interrupt the mocked stream hands the panel. Set per test. */
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

/** A manifest-flagged mid-run binding id, as a pack declares one. */
const PICK_RENDERER_ID = "@cinatra-test/pick-agent:pick";
const REVIEW_TASK_ID = "wayflow-task-3380";
const PICKED_JSON = JSON.stringify({ artifactId: "a-2", representationRevisionId: "r-2" });

/** The gate declares that its renderer must produce `selectedIdeaJson`. */
const DECLARING_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    selectedIdeaJson: { type: "string", title: "Selected idea (JSON)", "x-required": true },
  },
};

/** A gate that declares no renderer value: the email gates' object-level
 *  `required`, which no renderer writes and the rule does not read. */
const UNDECLARING_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["approve", "revise", "reject"] },
  },
  required: ["decision"],
};

/** A PICK RENDERER: it picks nothing for anyone and writes the pick into both
 *  keys when a row is pressed. */
function PickRenderer({ onChange }: FieldRendererProps) {
  return (
    <Button
      type="button"
      data-testid="pick-row-2"
      onClick={() => void onChange({ selectedIdeaJson: PICKED_JSON, userResponse: PICKED_JSON })}
    >
      Idea two
    </Button>
  );
}

type PanelProps = import("../orchestrator-stepper-panel").OrchestratorStepperPanelProps;

function baseProps(): PanelProps {
  return {
    runId: "run-3380",
    initialStatus: "pending_approval",
    initialError: null,
    agUiEnabled: false as boolean | null,
    agentPackageName: "@cinatra-test/pick-agent",
    inputParams: {},
    stepperSteps: [
      { index: 1, stepNumber: 0, label: "Pick", xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID },
    ],
    agentId: "cinatra-test/pick-agent",
    lgThreadId: null,
    templateId: "tmpl-3380",
    templateName: "Pick Agent",
  };
}

async function mountGate(schema: Record<string, unknown>) {
  INTERRUPT = {
    schema,
    xRenderer: PICK_RENDERER_ID,
    values: { ideas: [{ artifactId: "a-1" }, { artifactId: "a-2" }] },
    reviewTaskId: REVIEW_TASK_ID,
    // A mid-run interrupt carries no field name (the field is undefined).
  };
  const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
  return render(<OrchestratorStepperPanel {...baseProps()} />);
}

/** The gate's outer Continue: the one button that reads "Continue". */
function outerContinue(): HTMLButtonElement | null {
  const found = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter((b) =>
    /Continu/.test(b.textContent ?? ""),
  );
  expect(found.length).toBeLessThanOrEqual(1);
  return found[0] ?? null;
}

function pickRow(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('[data-testid="pick-row-2"]');
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
  );
  ensureDefaultFieldRenderersRegistered();
  fieldRendererRegistry.register({
    id: PICK_RENDERER_ID,
    priority: 100,
    condition: (_fieldName, schema) =>
      (schema as { "x-renderer"?: unknown })["x-renderer"] === PICK_RENDERER_ID,
    renderer: PickRenderer,
    midRunHitl: true,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  INTERRUPT = null;
  vi.clearAllMocks();
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
});

describe("OrchestratorStepperPanel — a mid-run Continue waits for the renderer's declared value (cinatra#3380)", () => {
  it("draws the Continue unavailable before a row is picked, and a press sends nothing", async () => {
    await mountGate(DECLARING_SCHEMA);

    await waitFor(() => expect(pickRow()).not.toBeNull());
    await waitFor(() => expect(outerContinue()).not.toBeNull());
    expect(outerContinue()!.disabled).toBe(true);

    fireEvent.click(outerContinue()!);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });

  it("makes the Continue available once the renderer writes the pick, and sends that pick", async () => {
    await mountGate(DECLARING_SCHEMA);

    await waitFor(() => expect(pickRow()).not.toBeNull());
    fireEvent.click(pickRow()!);

    await waitFor(() => expect(outerContinue()!.disabled).toBe(false));
    fireEvent.click(outerContinue()!);

    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const [taskId, payload] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(taskId).toBe(REVIEW_TASK_ID);
    expect(payload.selectedIdeaJson).toBe(PICKED_JSON);
    expect(payload.approved).toBe(true);
  });

  it("leaves a gate that declares no renderer value unchanged: its Continue is available before any write", async () => {
    await mountGate(UNDECLARING_SCHEMA);

    await waitFor(() => expect(pickRow()).not.toBeNull());
    await waitFor(() => expect(outerContinue()).not.toBeNull());
    expect(outerContinue()!.disabled).toBe(false);

    fireEvent.click(outerContinue()!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
  });
});
