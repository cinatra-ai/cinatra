// @vitest-environment jsdom
/**
 * A GATE WHOSE RENDERER ID NO BINDING DECLARES ANY MORE IS STILL ANSWERABLE.
 *
 * A run parks at a mid-run step whose stored schema names an `x-renderer` id.
 * When the package that declared that id drops the declaration (a later
 * version no longer draws that screen), the registry resolves nothing for the
 * id. Every live host then drew "Waiting for input — no renderer configured
 * for this step." and no Continue, so the parked run could not be answered.
 *
 * Pinned here:
 *   - `resolveHitlGateRenderer` gives such a gate the schema floor (the entry
 *     registered under the schema-field-fallback id), keeps a claimed id's own
 *     entry, and gives no floor to an empty or bare id or to an id a host draws
 *     inline (the artifact-review redirect, the trigger wait);
 *   - the registry's own `resolve` still answers null for the id, so a field
 *     inside a form is never drawn with the floor's Continue;
 *   - on the orchestrator stepper the gate draws its stored schema's field and
 *     one Continue, and the Continue sends the approval to the gate's review
 *     task once.
 *
 * Harness mirrors orchestrator-stepper-panel-next-input-gate-4244.test.tsx.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/unregistered-renderer-falls-to-floor.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import {
  ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
  SCHEMA_FIELD_FALLBACK_RENDERER_ID,
  TRIGGER_WAIT_STATUS_RENDERER_ID,
} from "../agent-builder-ids";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { fieldRendererRegistry, type FieldRendererContext } from "../field-renderer-registry";
import * as midRun from "../orchestrator-mid-run-hitl";

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

/** An id a package declared once and no longer declares. */
const DROPPED_ID = "@cinatra-test/retired-pack-agent:draft-confirm";
const TASK_ID = "wayflow-task-dropped";
const NOTE_FIELD = "note";
const STORED_SCHEMA = {
  type: "object",
  properties: {
    note: { type: "string", title: "Note" },
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
    runId: "run-dropped",
    initialStatus: "pending_approval",
    initialError: null,
    agUiEnabled: false as boolean | null,
    agentPackageName: "@cinatra-test/retired-pack-agent",
    inputParams: {},
    stepperSteps: [{ index: 1, stepNumber: 0, label: "Confirm", xRenderer: DROPPED_ID }],
    agentId: "cinatra-test/retired-pack-agent",
    lgThreadId: null,
    templateId: "tmpl-dropped",
    templateName: "Retired Pack Agent",
  };
}

const CONTEXT: FieldRendererContext = { connectedApps: [] };
const gateSchema = (xRenderer: string) => ({ ...STORED_SCHEMA, "x-renderer": xRenderer });

function continues(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter((b) =>
    /Continue|Submitting|Continuing/.test(b.textContent ?? ""),
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
  );
  fieldRendererRegistry.clear();
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

describe("resolveHitlGateRenderer", () => {
  // red-first-expect: resolveHitlGateRenderer is not a function
  it("gives a gate whose id no entry claims the schema floor", () => {
    expect(fieldRendererRegistry.resolve("hitl", gateSchema(DROPPED_ID), CONTEXT)).toBeNull();
    expect(midRun.resolveHitlGateRenderer("hitl", gateSchema(DROPPED_ID), CONTEXT)?.id).toBe(
      SCHEMA_FIELD_FALLBACK_RENDERER_ID,
    );
  });

  it("keeps a claimed id's own entry", () => {
    fieldRendererRegistry.register({
      id: DROPPED_ID,
      priority: 90,
      condition: (_f, schema) => schema["x-renderer"] === DROPPED_ID,
      renderer: () => null,
    });
    expect(midRun.resolveHitlGateRenderer("hitl", gateSchema(DROPPED_ID), CONTEXT)?.id).toBe(DROPPED_ID);
  });

  it("gives no floor to an empty or bare id, or to an id a host draws inline", () => {
    for (const id of ["", "draft-confirm", ARTIFACT_REVIEW_REDIRECT_RENDERER_ID, TRIGGER_WAIT_STATUS_RENDERER_ID]) {
      expect(midRun.resolveHitlGateRenderer("hitl", gateSchema(id), CONTEXT), id).toBeNull();
    }
    expect(midRun.resolveHitlGateRenderer("hitl", { ...STORED_SCHEMA }, CONTEXT)).toBeNull();
  });
});

describe("OrchestratorStepperPanel - a gate whose renderer id no binding declares", () => {
  // red-first-expect: expected null not to be null
  it("draws the stored schema's field and one Continue, not the no-renderer paragraph", async () => {
    INTERRUPT = { schema: STORED_SCHEMA, xRenderer: DROPPED_ID, values: {}, reviewTaskId: TASK_ID };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);
    await waitFor(() => expect(document.getElementById(`field-${NOTE_FIELD}`)).not.toBeNull());
    expect(document.body.textContent ?? "").not.toMatch(/no renderer configured/);
    await waitFor(() => expect(continues()).toHaveLength(1));
  });

  it("sends the written answer to the gate's review task once", async () => {
    INTERRUPT = { schema: STORED_SCHEMA, xRenderer: DROPPED_ID, values: {}, reviewTaskId: TASK_ID };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);
    await waitFor(() => expect(document.getElementById(`field-${NOTE_FIELD}`)).not.toBeNull());
    fireEvent.change(document.getElementById(`field-${NOTE_FIELD}`)!, { target: { value: "Go ahead." } });
    await waitFor(() => expect(continues()).toHaveLength(1));
    fireEvent.click(continues()[0]!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    expect((hitlActions.approveReviewTask.mock.calls[0] as unknown[])[0]).toBe(TASK_ID);
    expect((hitlActions.approveReviewTask.mock.calls[0] as unknown[])[1]).toEqual({ [NOTE_FIELD]: "Go ahead." });
    await new Promise((r) => setTimeout(r, 20));
    expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1);
  });
});
