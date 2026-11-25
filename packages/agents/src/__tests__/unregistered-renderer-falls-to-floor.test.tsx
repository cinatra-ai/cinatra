// @vitest-environment jsdom
/**
 * A STEP WHOSE SCREEN IS NO LONGER DECLARED IS REFUSED, NEVER DRAWN AS A
 * PLAIN FORM.
 *
 * A run parks at a mid-run step whose stored schema names an `x-renderer` id.
 * The step's durable record holds that id, the schema, the values and the
 * field name, but no kind and no `midRunHitl` flag. When the package that
 * declared the id drops the declaration, the host knows nothing more about
 * the id than about one it has never seen, and the schema does not tell a
 * confirmation from a decision or a picker. So the plain form never stands in
 * for such a step.
 *
 * Pinned here:
 *   - `resolveHitlGateRenderer` answers exactly as the registry does: a
 *     claimed id keeps its own entry, the plain form's own id is drawn by the
 *     plain form, and an id no entry claims gets no renderer (a former
 *     decision or picker step such as an idea selection, a context selector,
 *     a send confirmation or a publish confirmation, and an id the host has
 *     never seen);
 *   - on the orchestrator stepper such a step shows "no renderer configured",
 *     no field and no Continue, and nothing is sent;
 *   - a step recorded under the plain form's own id draws its stored schema's
 *     field and one Continue, and the Continue sends the floor's approval,
 *     carrying the entered value as the resume text, to the gate's review
 *     task once;
 *   - a TOMBSTONED id (a retired review gate) never resolves, a tombstoned
 *     binding never registers, and on the stepper the gate shows "no renderer
 *     configured" and no Continue.
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

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import * as registration from "../register-default-renderers";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { fieldRendererRegistry, type FieldRendererContext } from "../field-renderer-registry";
import * as midRun from "../orchestrator-mid-run-hitl";
import { makeExtensionFieldRenderer } from "../extension-field-renderer";

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

/**
 * Mid-run decision and picker steps whose packages dropped the declarations:
 * the generated bindings no longer list them.
 */
const DROPPED = vi.hoisted(() => [
  "@cinatra-ai/blog-pipeline-agent:idea-selection",
  "@cinatra-ai/context-selection-agent:context-selector",
  "@cinatra-ai/email-delivery-agent:send-confirmation",
  "@cinatra-ai/blog-wordpress-publish-agent:draft-confirm",
]);
vi.mock("@/lib/generated/agent-bindings", async (orig) => {
  const real = await orig<typeof import("@/lib/generated/agent-bindings")>();
  return {
    ...real,
    GENERATED_FIELD_RENDERER_BINDINGS: real.GENERATED_FIELD_RENDERER_BINDINGS.filter(
      (b) => !DROPPED.includes(b.id),
    ),
  };
});

/** An id no binding has ever declared. */
const NEVER_SEEN_ID = "@cinatra-test/never-seen-agent:screen";
/** The plain form's own id: a step that declares no screen of its own. */
const FLOOR_ID = SCHEMA_FIELD_FALLBACK_RENDERER_ID;
/** The idea selection's answer field, as its step asks for it. */
const PICK_SCHEMA = {
  type: "object",
  properties: { selectedIdeaJson: { type: "string", title: "Selected idea" } },
};
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
    stepperSteps: [{ index: 1, stepNumber: 0, label: "Confirm", xRenderer: FLOOR_ID }],
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
  it("refuses a former decision or picker step whose declaration is gone", () => {
    for (const id of DROPPED) {
      expect(fieldRendererRegistry.list().some((e) => e.id === id), id).toBe(false);
      for (const schema of [PICK_SCHEMA, STORED_SCHEMA, { type: "object" }, { type: "string" }]) {
        expect(midRun.resolveHitlGateRenderer("hitl", { ...schema, "x-renderer": id }, CONTEXT), id).toBeNull();
      }
    }
  });

  // red-first-expect: resolveHitlGateRenderer is not a function
  it("refuses a renderer id the host has never seen", () => {
    for (const id of [NEVER_SEEN_ID, "@cinatra-ai/some-retired-agent:old-screen", "never-seen"]) {
      expect(midRun.resolveHitlGateRenderer("hitl", gateSchema(id), CONTEXT), id).toBeNull();
    }
  });

  // red-first-expect: resolveHitlGateRenderer is not a function
  it("draws a step recorded under the plain form's own id with the plain form", () => {
    expect(midRun.resolveHitlGateRenderer("hitl", gateSchema(FLOOR_ID), CONTEXT)?.id).toBe(FLOOR_ID);
  });

  // red-first-expect: resolveHitlGateRenderer is not a function
  it("keeps a claimed id's own entry", () => {
    fieldRendererRegistry.register({
      id: NEVER_SEEN_ID,
      priority: 90,
      condition: (_f, schema) => schema["x-renderer"] === NEVER_SEEN_ID,
      renderer: () => null,
    });
    expect(midRun.resolveHitlGateRenderer("hitl", gateSchema(NEVER_SEEN_ID), CONTEXT)?.id).toBe(NEVER_SEEN_ID);
  });

  // red-first-expect: TOMBSTONED_HITL_RENDERER_IDS is not iterable
  it("gives no renderer to any tombstoned id", () => {
    const tombstoned = [...midRun.TOMBSTONED_HITL_RENDERER_IDS];
    expect(tombstoned.length).toBeGreaterThan(0);
    for (const id of tombstoned) {
      expect(fieldRendererRegistry.resolve("hitl", gateSchema(id), CONTEXT), id).toBeNull();
      expect(midRun.resolveHitlGateRenderer("hitl", gateSchema(id), CONTEXT), id).toBeNull();
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

describe("OrchestratorStepperPanel - a step whose screen is no longer declared is refused", () => {
  it("a former decision or picker step shows no field and no Continue, and nothing is sent", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    for (const id of [...DROPPED, NEVER_SEEN_ID]) {
      INTERRUPT = { schema: PICK_SCHEMA, xRenderer: id, values: {}, reviewTaskId: TASK_ID };
      render(
        <OrchestratorStepperPanel
          {...baseProps()}
          stepperSteps={[{ index: 1, stepNumber: 0, label: "Pick", xRenderer: id }]}
        />,
      );
      await waitFor(() => expect(document.body.textContent ?? "", id).toMatch(/no renderer configured/));
      expect(document.getElementById("field-selectedIdeaJson"), id).toBeNull();
      expect(continues(), id).toHaveLength(0);
      expect(hitlActions.approveReviewTask, id).not.toHaveBeenCalled();
      cleanup();
    }
  });
});

describe("OrchestratorStepperPanel - a step recorded under the plain form's own id", () => {
  it("draws the stored schema's field and one Continue, not the no-renderer paragraph", async () => {
    INTERRUPT = { schema: STORED_SCHEMA, xRenderer: FLOOR_ID, values: {}, reviewTaskId: TASK_ID };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);
    await waitFor(() => expect(document.getElementById(`field-${NOTE_FIELD}`)).not.toBeNull());
    expect(document.body.textContent ?? "").not.toMatch(/no renderer configured/);
    await waitFor(() => expect(continues()).toHaveLength(1));
  });

  it("sends the written answer to the gate's review task once", async () => {
    INTERRUPT = { schema: STORED_SCHEMA, xRenderer: FLOOR_ID, values: {}, reviewTaskId: TASK_ID };
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

/** One-value plain-form gates, with what is typed and what the run receives. */
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

describe("OrchestratorStepperPanel - a one-value plain-form gate sends the entered value", () => {
  for (const g of ONE_VALUE_GATES) {
    // red-first-expect: to match object { approved: true,
    it(`a ${g.shape} gate resumes with the entered value, not the approval marker`, async () => {
      INTERRUPT = {
        schema: g.schema,
        xRenderer: FLOOR_ID,
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

// AN EXTENSION WRAPPER THAT FALLS BACK TO THE PLAIN FORM ANSWERS AS THE PLAIN
// FORM DOES, whatever its registry entry says: the typed answer is the resume
// text (`userResponse`), never the setup-loop shape.
describe("OrchestratorStepperPanel - an extension wrapper in fallback", () => {
  const EXTENSION_ID = "@cinatra-test/ext-agent:screen";

  // red-first-expect: expected { answer: 'Ship it.' } to match object { approved: true, …(3) }
  it("sends the typed answer as the resume text", async () => {
    fieldRendererRegistry.register({
      id: EXTENSION_ID,
      priority: 90,
      condition: (_f, schema) => schema["x-renderer"] === EXTENSION_ID,
      renderer: makeExtensionFieldRenderer(EXTENSION_ID),
      drawsOwnSubmit: true,
    });
    INTERRUPT = {
      schema: { type: "string", title: "Answer" },
      xRenderer: EXTENSION_ID,
      values: {},
      reviewTaskId: TASK_ID,
      fieldName: "answer",
    };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);
    await waitFor(() => expect(document.getElementById("field-answer")).not.toBeNull());
    fireEvent.change(document.getElementById("field-answer")!, { target: { value: "Ship it." } });
    await waitFor(() => expect(continues()).toHaveLength(1));
    fireEvent.click(continues()[0]!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const call = hitlActions.approveReviewTask.mock.calls[0] as unknown[];
    expect(call[0]).toBe(TASK_ID);
    expect(call[1]).toMatchObject({
      approved: true,
      userResponse: "Ship it.",
      userResponseFieldName: "answer",
      answer: "Ship it.",
    });
    expect(call[2]).toBeUndefined();
  });
});

// The generic-object confirmation (a bare object schema, nothing to fill in, a
// Continue alone) is the FLOOR's: it holds for a gate the floor draws and
// never for a gate whose own registered renderer claims it.
describe("OrchestratorStepperPanel - a bare object gate", () => {
  const OWN_ID = "@cinatra-test/live-pack-agent:confirm-screen";
  const BARE = { type: "object" };

  it("the floor draws it as the Continue-only confirmation, which sends the approval", async () => {
    INTERRUPT = { schema: BARE, xRenderer: FLOOR_ID, values: {}, reviewTaskId: TASK_ID };
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

// THE `@cinatra/` SCOPE IS A PACKAGE SCOPE, NOT A RETIRED ONE. Installation
// (`detectSourceRef`) and binding validation (`BINDING_ID_RE`) accept it, so a
// package `@cinatra/foo` with a renderer `@cinatra/foo:output` registers,
// resolves and draws its paused step. Only the listed ids and the listed
// retired packages are refused.
describe("a renderer of a `@cinatra/` package", () => {
  const LIVE_ID = "@cinatra/foo:output";
  const LIVE_SCHEMA = {
    type: "object",
    properties: { reply: { type: "string", title: "Reply" } },
  };

  // red-first-expect: isTombstonedHitlRendererId is not a function
  it("registers, resolves and is classified mid-run like any other package's renderer", () => {
    expect(midRun.isTombstonedHitlRendererId(LIVE_ID)).toBe(false);
    registration.registerFieldRendererBindings([{ id: LIVE_ID, kind: "cta", priority: 90 }]);
    expect(fieldRendererRegistry.list().some((e) => e.id === LIVE_ID)).toBe(true);
    expect(midRun.resolveHitlGateRenderer("hitl", gateSchema(LIVE_ID), CONTEXT)?.id).toBe(LIVE_ID);
    expect(midRun.classifyMidRunHitl(LIVE_ID)).toBe(true);
  });

  it("draws its paused step on the stepper with a Continue that answers the gate", async () => {
    registration.registerFieldRendererBindings([{ id: LIVE_ID, kind: "cta", priority: 90 }]);
    INTERRUPT = { schema: LIVE_SCHEMA, xRenderer: LIVE_ID, values: {}, reviewTaskId: TASK_ID };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(
      <OrchestratorStepperPanel
        {...baseProps()}
        stepperSteps={[{ index: 1, stepNumber: 0, label: "Reply", xRenderer: LIVE_ID }]}
      />,
    );
    await waitFor(() => expect(continues()).toHaveLength(1));
    expect(document.body.textContent ?? "").not.toMatch(/no renderer configured/);
    fireEvent.click(continues()[0]!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    expect((hitlActions.approveReviewTask.mock.calls[0] as unknown[])[0]).toBe(TASK_ID);
  });

  // red-first-expect: TOMBSTONED_HITL_RENDERER_PACKAGES is not iterable
  it("each listed id and each id of a listed retired package stays refused", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const packageIds = [...midRun.TOMBSTONED_HITL_RENDERER_PACKAGES].map((p) => `${p}:any-screen`);
    for (const id of [...midRun.TOMBSTONED_HITL_RENDERER_IDS, ...packageIds]) {
      expect(midRun.isTombstonedHitlRendererId(id), id).toBe(true);
      expect(midRun.classifyMidRunHitl(id), id).toBe(false);
      registration.registerFieldRendererBindings([{ id, kind: "cta", priority: 90 }]);
      expect(fieldRendererRegistry.list().some((e) => e.id === id), id).toBe(false);
      expect(midRun.resolveHitlGateRenderer("hitl", gateSchema(id), CONTEXT), id).toBeNull();
    }
    warn.mockRestore();
  });

  // red-first-expect: Cannot read properties of undefined (reading 'has')
  it("agrees with the installation and validation rules: an id they accept is refused only when listed", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { BINDING_ID_RE } = await import("../../../../scripts/extensions/agent-binding-kinds.mjs");
    const installSrc = readFileSync(
      join(__dirname, "..", "..", "..", "extensions", "src", "add-from-chat.ts"),
      "utf8",
    );
    // The scopes installation takes from the private registry.
    const scopeLine = installSrc.split("\n").find((l) => l.includes("isPrivateScope ="));
    expect(scopeLine).toBeDefined();
    const scopes = [...scopeLine!.matchAll(/startsWith\("(@[^"]+\/)"\)/g)].map((m) => m[1]!);
    expect(scopes).toContain("@cinatra/");
    expect(scopes).toContain("@cinatra-ai/");
    const packages = ["foo", "email-agent", "email-reviewer-agent", "context-selection-agent", "x"];
    const locals = ["output", "ai-review-panel", "draft-review", "setup-form", "review", "screen"];
    for (const scope of scopes) {
      for (const pkg of packages) {
        for (const local of locals) {
          const id = `${scope}${pkg}:${local}`;
          expect(BINDING_ID_RE.test(id), id).toBe(true);
          const listed =
            midRun.TOMBSTONED_HITL_RENDERER_IDS.has(id) ||
            midRun.TOMBSTONED_HITL_RENDERER_PACKAGES.has(`${scope}${pkg}`);
          expect(midRun.isTombstonedHitlRendererId(id), id).toBe(listed);
        }
      }
    }
    // A listed id that validation accepts sits in a scope installation accepts.
    for (const id of midRun.TOMBSTONED_HITL_RENDERER_IDS) {
      if (!BINDING_ID_RE.test(id)) continue;
      expect(scopes.some((s) => id.startsWith(s)), id).toBe(true);
    }
  });
});
