// @vitest-environment jsdom
/**
 * THE ORCHESTRATOR STEPPER: A PARKED STEP IS ANSWERED ONLY WHERE A SCREEN DRAWS
 * IT; A BINDING THE PLAIN FORM DRAWS SENDS THE TYPED VALUE; A COMPLETED
 * ONE-VALUE ANSWER SHOWS AGAIN.
 *
 *   - A step whose recorded renderer id no entry claims shows "no renderer
 *     configured for this step" and no Continue, even when its id's name reads
 *     as mid-run (`@acme/removed:output`). A claimed id keeps its Continue.
 *   - A binding of a package that is not in the build keeps its own id while
 *     the plain form draws it (`drawnBySchemaFloor`). Its step is answered as
 *     the plain form's own step: one Continue, and the typed value travels as
 *     `userResponse` and is recorded under its field. A binding with its own
 *     component is not drawn by the plain form.
 *   - A completed one-value answer is kept as a keyed record; the read-only
 *     replay shows the value itself (`submittedAnswerValue`). An object answer
 *     replays as before.
 *
 * Harness mirrors unregistered-renderer-falls-to-floor.test.tsx.
 *
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/parked-step-screen-and-answer-replay.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
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


import * as hitlSubmit from "../hitl-gate-submit";

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

const TASK_ID = "wayflow-task-parked";
const FLOOR_ID = SCHEMA_FIELD_FALLBACK_RENDERER_ID;

function baseProps(xRenderer: string, overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    runId: "run-parked",
    initialStatus: "pending_approval",
    initialError: null,
    agUiEnabled: false as boolean | null,
    agentPackageName: "@cinatra-test/parked-agent",
    inputParams: {},
    stepperSteps: [{ index: 1, stepNumber: 0, label: "Step", xRenderer }],
    agentId: "cinatra-test/parked-agent",
    lgThreadId: null,
    templateId: "tmpl-parked",
    templateName: "Parked Agent",
    ...overrides,
  };
}

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

// ---------------------------------------------------------------------------
// A step no screen draws
// ---------------------------------------------------------------------------

describe("OrchestratorStepperPanel - a step whose renderer id no entry claims", () => {
  const REMOVED_ID = "@acme/removed:output";
  const CLAIMED_ID = "@acme/live:output";

  // red-first-expect: to have a length of +0 but got 1
  it("shows the no-renderer paragraph and no Continue, though its id reads as mid-run", async () => {
    INTERRUPT = { schema: { type: "object" }, xRenderer: REMOVED_ID, values: {}, reviewTaskId: TASK_ID };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps(REMOVED_ID)} />);
    await waitFor(() => expect(document.body.textContent ?? "").toMatch(/no renderer configured/));
    expect(continues()).toHaveLength(0);
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });

  it("keeps the Continue of a claimed id with the same name", async () => {
    fieldRendererRegistry.register({
      id: CLAIMED_ID,
      priority: 90,
      condition: (_f, schema) => schema["x-renderer"] === CLAIMED_ID,
      renderer: () => <div data-testid="live-renderer">Live screen</div>,
    });
    INTERRUPT = { schema: { type: "object" }, xRenderer: CLAIMED_ID, values: {}, reviewTaskId: TASK_ID };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps(CLAIMED_ID)} />);
    await waitFor(() => expect(document.querySelector('[data-testid="live-renderer"]')).not.toBeNull());
    expect(continues()).toHaveLength(1);
    fireEvent.click(continues()[0]!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    expect((hitlActions.approveReviewTask.mock.calls[0] as unknown[])[0]).toBe(TASK_ID);
  });
});

// ---------------------------------------------------------------------------
// A binding the plain form draws
// ---------------------------------------------------------------------------

/** A run-time binding of a package that is not in this build: the plain form draws it. */
const RUNTIME_PICK_ID = "@cinatra-test/ideas-agent:idea-selection";
/** A run-time binding whose kind has a component of its own. */
const RUNTIME_OWN_ID = "@cinatra-test/ideas-agent:call-to-action";

function registerRuntimeBindings() {
  registration.registerFieldRendererBindings([
    { id: RUNTIME_PICK_ID, kind: "blog-idea-selection", priority: 80, midRunHitl: true },
    { id: RUNTIME_OWN_ID, kind: "cta", priority: 80, midRunHitl: true },
  ]);
}

const FIELD = "selectedIdeaJson";

/** One-value steps: the schema, how the value is entered, what is sent and recorded. */
const PLAIN_FORM_ANSWERS: Array<{
  shape: string;
  schema: Record<string, unknown>;
  enter: () => void;
  text: string;
  value: unknown;
}> = [
  {
    shape: "text",
    schema: { type: "string", title: "Selected idea" },
    enter: () => fireEvent.change(document.getElementById(`field-${FIELD}`)!, { target: { value: "idea-7" } }),
    text: "idea-7",
    value: "idea-7",
  },
  {
    shape: "number",
    schema: { type: "number", title: "Selected idea" },
    enter: () => fireEvent.change(document.getElementById(`field-${FIELD}`)!, { target: { value: "7" } }),
    text: "7",
    value: 7,
  },
  {
    shape: "yes/no",
    schema: { type: "boolean", title: "Selected idea" },
    enter: () => fireEvent.click(document.querySelector('[role="checkbox"]')!),
    text: "true",
    value: true,
  },
  {
    shape: "list",
    schema: { type: "array", title: "Selected idea", items: { type: "string" } },
    enter: () => fireEvent.change(document.getElementById(`field-${FIELD}`)!, { target: { value: "a\nb" } }),
    text: '["a","b"]',
    value: ["a", "b"],
  },
];

describe("OrchestratorStepperPanel - a run-time binding the plain form draws", () => {
  for (const a of PLAIN_FORM_ANSWERS) {
    // red-first-expect: AssertionError: expected 
    it(`a ${a.shape} step sends the typed value as the resume text and records it under its field`, async () => {
      registerRuntimeBindings();
      INTERRUPT = {
        schema: a.schema,
        xRenderer: RUNTIME_PICK_ID,
        values: {},
        reviewTaskId: TASK_ID,
        fieldName: FIELD,
      };
      const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
      render(<OrchestratorStepperPanel {...baseProps(RUNTIME_PICK_ID)} />);
      await waitFor(() => expect(document.getElementById(`field-${FIELD}`)).not.toBeNull());
      a.enter();
      await waitFor(() => expect(continues()).toHaveLength(1));
      fireEvent.click(continues()[0]!);
      await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
      const [taskId, payload] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(taskId).toBe(TASK_ID);
      expect(payload).toMatchObject({ approved: true, userResponse: a.text, userResponseFieldName: FIELD });
      expect(hitlSubmit.readWayflowSubmittedValues(payload)).toEqual({ [FIELD]: a.value });
    });
  }

  // red-first-expect: to have a length of 1 but got 2
  it("an object step that asks for the idea sends the typed idea as the resume text", async () => {
    registerRuntimeBindings();
    INTERRUPT = {
      schema: { type: "object", properties: { [FIELD]: { type: "string", title: "Selected idea" } } },
      xRenderer: RUNTIME_PICK_ID,
      values: {},
      reviewTaskId: TASK_ID,
    };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps(RUNTIME_PICK_ID)} />);
    await waitFor(() => expect(document.getElementById(`field-${FIELD}`)).not.toBeNull());
    fireEvent.change(document.getElementById(`field-${FIELD}`)!, { target: { value: "idea-7" } });
    await waitFor(() => expect(continues()).toHaveLength(1));
    fireEvent.click(continues()[0]!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const payload = (hitlActions.approveReviewTask.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(payload).toMatchObject({ approved: true, userResponse: "idea-7", userResponseFieldName: FIELD });
    expect(hitlSubmit.readWayflowSubmittedValues(payload)).toEqual({ [FIELD]: "idea-7" });
  });

  // red-first-expect: gateDrawnBySchemaFloor is not a function
  it("the registry marks the plain-form binding, and not the binding with its own component", () => {
    registerRuntimeBindings();
    const entryFor = (id: string) =>
      fieldRendererRegistry.resolve("hitl-field", { type: "string", "x-renderer": id }, { connectedApps: [] });
    expect(midRun.gateDrawnBySchemaFloor(RUNTIME_PICK_ID, entryFor(RUNTIME_PICK_ID))).toBe(true);
    expect(midRun.gateDrawnBySchemaFloor(RUNTIME_OWN_ID, entryFor(RUNTIME_OWN_ID))).toBe(false);
  });

  it("a binding with its own component stays a mid-run step with the outer Continue", async () => {
    registerRuntimeBindings();
    INTERRUPT = { schema: { type: "string" }, xRenderer: RUNTIME_OWN_ID, values: {}, reviewTaskId: TASK_ID };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps(RUNTIME_OWN_ID)} />);
    await waitFor(() => expect(continues()).toHaveLength(1));
    expect(document.body.textContent ?? "").not.toMatch(/no renderer configured/);
    fireEvent.click(continues()[0]!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const payload = (hitlActions.approveReviewTask.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(payload.approved).toBe(true);
    expect(payload.userResponseFieldName).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The read-only replay of a completed one-value answer
// ---------------------------------------------------------------------------

/** Renders the completed step through the real replay, from what was kept for it. */
async function replay(schema: Record<string, unknown>, submittedValues: Record<string, unknown> | null) {
  INTERRUPT = null;
  const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
  render(
    <OrchestratorStepperPanel
      {...baseProps(FLOOR_ID, {
        initialStatus: "completed",
        submissionMap: [[1, { submittedValues, schemaSnapshot: schema, stepKey: "step-0" }]],
      })}
    />,
  );
  const open = await waitFor(() => {
    const row = document.querySelector('[data-rail-replay="open"] button');
    expect(row).not.toBeNull();
    return row as HTMLButtonElement;
  });
  fireEvent.click(open);
  await waitFor(() => expect(document.querySelector("fieldset[disabled]")).not.toBeNull());
}

/** What the server keeps for a plain-form answer: the writer's payload, as the reader records it. */
function kept(schema: Record<string, unknown>, value: unknown, fieldName?: string) {
  const payload = hitlSubmit.buildSchemaFloorGatePayload({ schema, next: value, fieldName });
  return hitlSubmit.readWayflowSubmittedValues(payload);
}

const REPLAYED: Array<{ shape: string; schema: Record<string, unknown>; value: unknown; shown: string | boolean }> = [
  { shape: "text", schema: { type: "string", title: "Answer" }, value: "Ship it.", shown: "Ship it." },
  { shape: "number", schema: { type: "number", title: "Answer" }, value: 42, shown: "42" },
  { shape: "zero", schema: { type: "number", title: "Answer" }, value: 0, shown: "0" },
  { shape: "list", schema: { type: "array", title: "Answer", items: { type: "string" } }, value: ["a", "b"], shown: "a\nb" },
  { shape: "true", schema: { type: "boolean", title: "Answer" }, value: true, shown: true },
  { shape: "false", schema: { type: "boolean", title: "Answer" }, value: false, shown: false },
  { shape: "empty text", schema: { type: "string", title: "Answer" }, value: "", shown: "" },
];

function shownValue(expected: string | boolean): string | boolean {
  if (typeof expected === "boolean") {
    return document.querySelector('fieldset[disabled] [role="checkbox"]')!.getAttribute("aria-checked") === "true";
  }
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    "fieldset[disabled] input:not([type=checkbox]), fieldset[disabled] textarea",
  );
  return input!.value;
}

describe("OrchestratorStepperPanel - the replay of a completed one-value answer", () => {
  for (const r of REPLAYED) {
    // red-first-expect: buildSchemaFloorGatePayload is not a function
    it(`shows a kept ${r.shape} answer, unnamed`, async () => {
      await replay(r.schema, kept(r.schema, r.value));
      expect(shownValue(r.shown)).toEqual(r.shown);
    });
    // red-first-expect: buildSchemaFloorGatePayload is not a function
    it(`shows a kept ${r.shape} answer under its field name`, async () => {
      await replay(r.schema, kept(r.schema, r.value, "answer"));
      expect(shownValue(r.shown)).toEqual(r.shown);
    });
  }

  // red-first-expect: buildSchemaFloorGatePayload is not a function
  it("shows the answer the page itself recorded when the step was submitted", async () => {
    const schema = { type: "number", title: "Answer" };
    const payload = hitlSubmit.buildSchemaFloorGatePayload({ schema, next: 42, fieldName: "answer" });
    await replay(schema, payload);
    expect(shownValue("42")).toBe("42");
  });

  it("replays an object answer as the whole object, as before", async () => {
    const schema = { type: "object", properties: { note: { type: "string", title: "Note" } } };
    await replay(schema, { note: "Go ahead." });
    expect((document.getElementById("field-note") as HTMLInputElement | null)?.value).toBe("Go ahead.");
  });
});
