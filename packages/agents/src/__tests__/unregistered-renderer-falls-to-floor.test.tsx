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
 *   - a TOMBSTONED id (a retired review gate) and an id of a review or mid-run
 *     kind never take the floor, and a tombstoned binding never registers;
 *   - on the orchestrator stepper the gate draws its stored schema's field and
 *     one Continue, and the Continue sends the floor's approval, carrying the
 *     written note as the resume text, to the gate's review task once;
 *   - on the stepper a tombstoned gate still shows "no renderer configured"
 *     and no Continue.
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
import * as registration from "../register-default-renderers";
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

  // red-first-expect: resolveHitlGateRenderer is not a function
  it("keeps a claimed id's own entry", () => {
    fieldRendererRegistry.register({
      id: DROPPED_ID,
      priority: 90,
      condition: (_f, schema) => schema["x-renderer"] === DROPPED_ID,
      renderer: () => null,
    });
    expect(midRun.resolveHitlGateRenderer("hitl", gateSchema(DROPPED_ID), CONTEXT)?.id).toBe(DROPPED_ID);
  });

  // red-first-expect: resolveHitlGateRenderer is not a function
  it("gives no floor to an empty or bare id, or to an id a host draws inline", () => {
    for (const id of ["", "draft-confirm", ARTIFACT_REVIEW_REDIRECT_RENDERER_ID, TRIGGER_WAIT_STATUS_RENDERER_ID]) {
      expect(midRun.resolveHitlGateRenderer("hitl", gateSchema(id), CONTEXT), id).toBeNull();
    }
    expect(midRun.resolveHitlGateRenderer("hitl", { ...STORED_SCHEMA }, CONTEXT)).toBeNull();
  });

  // red-first-expect: TOMBSTONED_HITL_RENDERER_IDS is not iterable
  it("gives no floor to any tombstoned id", () => {
    const tombstoned = [...midRun.TOMBSTONED_HITL_RENDERER_IDS];
    expect(tombstoned.length).toBeGreaterThan(0);
    for (const id of tombstoned) {
      expect(fieldRendererRegistry.resolve("hitl", gateSchema(id), CONTEXT), id).toBeNull();
      expect(midRun.resolveHitlGateRenderer("hitl", gateSchema(id), CONTEXT), id).toBeNull();
    }
  });

  // red-first-expect: resolveHitlGateRenderer is not a function
  it("gives no floor to an id of the retired scope or of a review or mid-run kind", () => {
    for (const id of [
      "@cinatra/some-retired-agent:old-screen",
      "@cinatra-ai/some-retired-agent:old-review",
      "@cinatra-ai/some-retired-agent:review-panel",
      "@cinatra-ai/some-retired-agent:output",
      "@cinatra-ai/some-retired-agent:drafts-output",
      "@cinatra-ai/some-retired-agent:list-picker",
      "@cinatra-ai/some-retired-agent:setup-form",
    ]) {
      expect(midRun.resolveHitlGateRenderer("hitl", gateSchema(id), CONTEXT), id).toBeNull();
    }
  });

  // red-first-expect: resolveHitlGateRenderer is not a function
  it("still gives a plainly retired screen id the floor", () => {
    for (const id of [DROPPED_ID, "@cinatra-ai/some-retired-agent:old-screen"]) {
      expect(midRun.resolveHitlGateRenderer("hitl", gateSchema(id), CONTEXT)?.id, id).toBe(
        SCHEMA_FIELD_FALLBACK_RENDERER_ID,
      );
    }
  });

  // red-first-expect: expected true to be false
  it("never registers a binding whose id is tombstoned", () => {
    const tombstoned = "@cinatra/email-reviewer-agent:ai-review-panel";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    registration.registerFieldRendererBindings([
      { id: tombstoned, kind: "cta", priority: 90 },
      { id: "@cinatra-ai/some-live-agent:screen", kind: "cta", priority: 90 },
    ]);
    warn.mockRestore();
    const ids = fieldRendererRegistry.list().map((e) => e.id);
    expect(ids.includes(tombstoned)).toBe(false);
    expect(ids.includes("@cinatra-ai/some-live-agent:screen")).toBe(true);
    expect(midRun.resolveHitlGateRenderer("hitl", gateSchema(tombstoned), CONTEXT)).toBeNull();
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

  // red-first-expect: expected null not to be null
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
    // The floor's approval: the note is the resume text the run receives
    // (`userResponse`), not the bare "[Approved by operator]" marker.
    expect((hitlActions.approveReviewTask.mock.calls[0] as unknown[])[1]).toMatchObject({
      [NOTE_FIELD]: "Go ahead.",
      approved: true,
      userResponse: "Go ahead.",
      userResponseFieldName: NOTE_FIELD,
    });
    expect((hitlActions.approveReviewTask.mock.calls[0] as unknown[])[2]).toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));
    expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1);
  });
});

/** One-value gates the floor draws on a retired id, with what is typed and what the run receives. */
const ONE_VALUE_GATES: Array<{ shape: string; schema: Record<string, unknown>; typed: string; text: string }> = [
  { shape: "string", schema: { type: "string", title: "Answer" }, typed: "Ship it.", text: "Ship it." },
  { shape: "number", schema: { type: "number", title: "Answer" }, typed: "42", text: "42" },
  {
    shape: "array",
    schema: { type: "array", title: "Answer", items: { type: "string" } },
    typed: "alpha\nbeta",
    text: '["alpha","beta"]',
  },
];

describe("OrchestratorStepperPanel - a one-value gate on a retired id sends the entered value", () => {
  for (const g of ONE_VALUE_GATES) {
    // red-first-expect: expected null not to be null
    it(`a ${g.shape} gate resumes with the entered value, not the approval marker`, async () => {
      INTERRUPT = {
        schema: g.schema,
        xRenderer: DROPPED_ID,
        values: {},
        reviewTaskId: TASK_ID,
        fieldName: "answer",
      };
      const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
      render(<OrchestratorStepperPanel {...baseProps()} />);
      await waitFor(() => expect(document.getElementById("field-answer")).not.toBeNull());
      fireEvent.change(document.getElementById("field-answer")!, { target: { value: g.typed } });
      await waitFor(() => expect(continues()).toHaveLength(1));
      fireEvent.click(continues()[0]!);
      await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
      const call = hitlActions.approveReviewTask.mock.calls[0] as unknown[];
      expect(call[0]).toBe(TASK_ID);
      expect(call[1]).toMatchObject({ approved: true, userResponse: g.text });
      expect(call[2]).toBeUndefined();
    });
  }
});

// The generic-object confirmation (a bare object schema, nothing to fill in, a
// Continue alone) is the FLOOR's: it holds for a gate the floor draws and
// never for a gate whose own registered renderer claims it.
describe("OrchestratorStepperPanel - a bare object gate", () => {
  const OWN_ID = "@cinatra-test/live-pack-agent:confirm-screen";
  const BARE = { type: "object" };

  // red-first-expect: expected [] to have a length of 1 but got +0
  it("the floor draws it as the Continue-only confirmation, which sends the approval", async () => {
    INTERRUPT = { schema: BARE, xRenderer: DROPPED_ID, values: {}, reviewTaskId: TASK_ID };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);
    await waitFor(() => expect(continues()).toHaveLength(1));
    expect(document.body.textContent ?? "").not.toMatch(/no renderer configured/);
    fireEvent.click(continues()[0]!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    expect((hitlActions.approveReviewTask.mock.calls[0] as unknown[])[0]).toBe(TASK_ID);
    expect((hitlActions.approveReviewTask.mock.calls[0] as unknown[])[1]).toMatchObject({ approved: true });
  });

  it("a registered renderer that claims it draws its own screen, with no Continue-only confirmation", async () => {
    fieldRendererRegistry.register({
      id: OWN_ID,
      priority: 90,
      condition: (_f, schema) => schema["x-renderer"] === OWN_ID,
      renderer: () => <div data-testid="own-renderer">Own screen</div>,
      drawsOwnSubmit: true,
    });
    INTERRUPT = { schema: BARE, xRenderer: OWN_ID, values: {}, reviewTaskId: TASK_ID };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(
      <OrchestratorStepperPanel
        {...baseProps()}
        stepperSteps={[{ index: 1, stepNumber: 0, label: "Confirm", xRenderer: OWN_ID }]}
      />,
    );
    await waitFor(() => expect(document.querySelector('[data-testid="own-renderer"]')).not.toBeNull());
    expect(continues()).toHaveLength(0);
  });
});

describe("OrchestratorStepperPanel - a tombstoned gate stays unanswerable", () => {
  // red-first-expect: TOMBSTONED_HITL_RENDERER_IDS is not iterable
  it("shows the no-renderer paragraph and no Continue for every tombstoned id", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    for (const id of midRun.TOMBSTONED_HITL_RENDERER_IDS) {
      INTERRUPT = { schema: STORED_SCHEMA, xRenderer: id, values: {}, reviewTaskId: TASK_ID };
      const props = baseProps();
      render(
        <OrchestratorStepperPanel
          {...props}
          stepperSteps={[{ index: 1, stepNumber: 0, label: "Confirm", xRenderer: id }]}
        />,
      );
      await waitFor(() => expect(document.body.textContent ?? "", id).toMatch(/no renderer configured/));
      expect(document.getElementById(`field-${NOTE_FIELD}`), id).toBeNull();
      expect(continues(), id).toHaveLength(0);
      cleanup();
    }
  });
});
