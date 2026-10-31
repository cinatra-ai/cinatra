// @vitest-environment jsdom
/**
 * cinatra#3532 — THE RUN WIZARD'S SETUP FIELD CAN BE PASSED.
 *
 * The run page's pause screen is drawn by this panel (the HITL screen card
 * frames it on the `run_card` host). Its setup-loop branch drew NO control of
 * its own and submitted on every `onChange`, so a field whose renderer draws no
 * submit control — the email outreach agent's `callToAction`, drawn by the pack
 * binding `@cinatra-ai/email-outreach-agent:cta` — offered the reader nothing to
 * press and could not be passed at all.
 *
 * What is pinned here:
 *   - a setup field whose registry entry declares NO submit control of its own
 *     is drawn with the product's Continue (`data-action="submit-hitl-screen"`,
 *     the same control the card draws), and that Continue submits the value the
 *     renderer is holding, under the gate's own field name;
 *   - the field that already carries a control — the schema-field fallback, the
 *     wizard's FIRST field — is untouched: no second Continue is drawn beside
 *     its own.
 *
 * Harness mirrors agentic-run-panel-hitl-field-label.test.tsx.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/agentic-run-panel-setup-continue-3532.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { Input } from "@/components/ui/input";
import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { fieldRendererRegistry } from "../field-renderer-registry";
import type { FieldRendererProps } from "../field-renderer-registry";

vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: ({ placeholder }: { placeholder?: string }) => (
    <div data-testid="field-assist-prompt-stub">{placeholder}</div>
  ),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("lucide-react", () => {
  const StubIcon = () => null;
  return new Proxy({} as Record<string, () => null>, {
    get: (_t, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["ArrowRight", "Check", "Loader2", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

const hitlActions = vi.hoisted(() => ({
  approveReviewTask: vi.fn(async () => ({ ok: true as const })),
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../hitl-actions", () => hitlActions);

vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(async () => null),
}));

vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-3532",
  })),
  getAuditAvailabilityAction: vi.fn(async () => ({
    visible: false,
    promptCount: 0,
    skillCount: 0,
  })),
  getSkillsForAgentAction: vi.fn(async () => []),
}));

vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() =>
    streamResultFor(CONTROL_LESS_RENDERER_ID, "callToAction", { type: "string" }),
  ),
}));

/**
 * A PACK-SHAPED RENDERER THAT DRAWS NO SUBMIT CONTROL — the shape #3532 was
 * reported on. It holds what the reader typed and hands it out through
 * `onChange`, exactly as `CtaRenderer` does, and draws no button at all.
 */
const CONTROL_LESS_RENDERER_ID = "@cinatra-test/pack-agent:cta-like";

function ControlLessRenderer({ fieldName, value, onChange }: FieldRendererProps) {
  const current = typeof value === "string" ? value : "";
  return (
    <div>
      <label htmlFor={`field-${fieldName}`}>Call To Action</label>
      <Input
        id={`field-${fieldName}`}
        value={current}
        onChange={(e) => void onChange(e.target.value)}
      />
    </div>
  );
}

/**
 * THE SAME SHAPE, plus a FLUSH REGISTRATION THAT OUTLIVED ITS RENDERER
 * (convergence finding 3). The extension wrapper mounts a loading floor first
 * and the loaded component second on the SAME gate, and a registration cannot
 * be withdrawn — so the departed floor's flush is still registered while the
 * reader answers in the component that replaced it. The flush here hands over
 * the empty reading the floor held; the reader's own answer must win.
 */
const STALE_FLUSH_RENDERER_ID = "@cinatra-test/pack-agent:stale-flush";

function StaleFlushRenderer({ fieldName, value, onChange, registerFlush }: FieldRendererProps) {
  const current = typeof value === "string" ? value : "";
  React.useEffect(() => {
    registerFlush?.(async () => {
      await onChange("");
    });
    // once, as the departed renderer registered it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Input
      id={`field-${fieldName}`}
      value={current}
      onChange={(e) => void onChange(e.target.value)}
    />
  );
}

/** An AG-UI stream result parked on a single-field setup gate. */
function streamResultFor(
  xRenderer: string,
  fieldName: string,
  schema: Record<string, unknown>,
  reviewTaskId = "setup-run-3532",
) {
  return {
    status: "pending_approval",
    error: null,
    presentationHint: null,
    isLive: true,
    interruptContext: {
      schema,
      xRenderer,
      values: { offeringCompanyWebsite: "https://example.com" },
      reviewTaskId,
      fieldName,
    },
    streamedText: "",
    dataPartFrames: [],
  };
}

const PANEL_PROPS = {
  runId: "run-3532",
  initialStatus: "pending_approval",
  initialError: null,
  initialMessages: [],
  agUiEnabled: true,
  templateId: "tmpl-3532",
};

async function renderPanel() {
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  return render(<AgenticRunPanel {...PANEL_PROPS} />);
}

async function setGate(
  xRenderer: string,
  fieldName: string,
  schema: Record<string, unknown>,
  reviewTaskId?: string,
) {
  const { useAgUiRunStream } = await import("../use-ag-ui-run-stream");
  (useAgUiRunStream as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
    streamResultFor(xRenderer, fieldName, schema, reviewTaskId),
  );
}

function productContinue(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    '[data-action="submit-hitl-screen"]',
  );
}

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  // The pack-shaped entry: no `drawsOwnSubmit`, so it declares no submit
  // control of its own — the whole point of the case.
  fieldRendererRegistry.register({
    id: CONTROL_LESS_RENDERER_ID,
    priority: 100,
    condition: (_fieldName, schema) =>
      (schema as { "x-renderer"?: unknown })["x-renderer"] === CONTROL_LESS_RENDERER_ID,
    renderer: ControlLessRenderer,
  });
  fieldRendererRegistry.register({
    id: STALE_FLUSH_RENDERER_ID,
    priority: 100,
    condition: (_fieldName, schema) =>
      (schema as { "x-renderer"?: unknown })["x-renderer"] === STALE_FLUSH_RENDERER_ID,
    renderer: StaleFlushRenderer,
  });
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // RESTORE THE REGISTRY this file wrote into: the stub entry must not outlive
  // the file for the rest of the package's run.
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
});

describe("AgenticRunPanel — a setup field whose renderer draws no control (cinatra#3532)", () => {
  it("draws the product's Continue beside the field", async () => {
    await setGate(CONTROL_LESS_RENDERER_ID, "callToAction", { type: "string" });
    await renderPanel();

    await waitFor(() =>
      expect(document.querySelector("#field-callToAction")).not.toBeNull(),
    );
    await waitFor(() => expect(productContinue()).not.toBeNull());
    expect(productContinue()!.textContent).toMatch(/Continue/);
  });

  it("the Continue passes the value the renderer holds — and typing alone submits nothing", async () => {
    await setGate(CONTROL_LESS_RENDERER_ID, "callToAction", { type: "string" });
    await renderPanel();

    await waitFor(() =>
      expect(document.querySelector("#field-callToAction")).not.toBeNull(),
    );
    fireEvent.change(document.querySelector("#field-callToAction")!, {
      target: { value: "Book a meeting: https://cal.example/intro" },
    });

    // The wizard no longer submits on every change — the reader decides when.
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();

    await waitFor(() => expect(productContinue()).not.toBeNull());
    fireEvent.click(productContinue()!);

    await waitFor(() =>
      expect(hitlActions.approveReviewTask).toHaveBeenCalledWith(
        "setup-run-3532",
        { callToAction: "Book a meeting: https://cal.example/intro" },
        "callToAction",
      ),
    );
  });

  it("leaves the fallback field alone — no second Continue beside its own", async () => {
    await setGate(SCHEMA_FIELD_FALLBACK_RENDERER_ID, "offeringCompanyWebsite", {
      type: "string",
    });
    await renderPanel();

    await waitFor(() =>
      expect(document.querySelector("#field-offeringCompanyWebsite")).not.toBeNull(),
    );
    expect(productContinue()).toBeNull();
  });

  // -------------------------------------------------------------------------
  // THE CONVERGENCE ROUND'S FINDINGS, each pinned by the case beneath it.
  // -------------------------------------------------------------------------

  it("keeps what the reader types in the field, keystroke by keystroke (finding 1)", async () => {
    await setGate(CONTROL_LESS_RENDERER_ID, "callToAction", { type: "string" });
    await renderPanel();

    const box = () => document.querySelector<HTMLInputElement>("#field-callToAction");
    await waitFor(() => expect(box()).not.toBeNull());

    // A field renderer is CONTROLLED by the `value` prop it is handed. Typing is
    // one change per character, so a staging path that fed nothing back would
    // clear the box after each one and pass a single character to the server.
    for (const text of ["B", "Bo", "Book a meeting"]) {
      fireEvent.change(box()!, { target: { value: text } });
      await waitFor(() => expect(box()!.value).toBe(text));
    }

    fireEvent.click(productContinue()!);
    await waitFor(() =>
      expect(hitlActions.approveReviewTask).toHaveBeenCalledWith(
        "setup-run-3532",
        { callToAction: "Book a meeting" },
        "callToAction",
      ),
    );
  });

  it("keeps the answer when a submit fails, so the next press sends it (finding 2)", async () => {
    await setGate(CONTROL_LESS_RENDERER_ID, "callToAction", { type: "string" });
    await renderPanel();

    await waitFor(() =>
      expect(document.querySelector("#field-callToAction")).not.toBeNull(),
    );
    fireEvent.change(document.querySelector("#field-callToAction")!, {
      target: { value: "Book a meeting" },
    });

    // The submit core turns a failure into a toast and returns; the reader is
    // still looking at their own answer, so the Continue must still send it.
    hitlActions.approveReviewTask.mockRejectedValueOnce(new Error("network"));
    fireEvent.click(productContinue()!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));

    fireEvent.click(productContinue()!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(2));
    expect(hitlActions.approveReviewTask).toHaveBeenLastCalledWith(
      "setup-run-3532",
      { callToAction: "Book a meeting" },
      "callToAction",
    );
  });

  it("a flush left behind by a replaced renderer cannot overwrite the reader's answer (finding 3)", async () => {
    await setGate(STALE_FLUSH_RENDERER_ID, "callToAction", { type: "string" });
    await renderPanel();

    await waitFor(() =>
      expect(document.querySelector("#field-callToAction")).not.toBeNull(),
    );
    fireEvent.change(document.querySelector("#field-callToAction")!, {
      target: { value: "Book a meeting" },
    });

    fireEvent.click(productContinue()!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalled());
    expect(hitlActions.approveReviewTask).toHaveBeenLastCalledWith(
      "setup-run-3532",
      { callToAction: "Book a meeting" },
      "callToAction",
    );
  });

  it("a binding whose component draws its own controls keeps its send on either resolution road (finding 4)", async () => {
    const { registerFieldRendererBindings } = await import("../register-default-renderers");
    // The shipped binding the convergence round named: its extension-shipped
    // component draws a Send test email AND a Continue and does not read
    // `hideSubmit`, so neither the extension road nor the host-kind road may
    // take its send away.
    registerFieldRendererBindings([
      {
        id: "@cinatra-ai/email-test-delivery-agent:input",
        kind: "test-delivery-input",
        priority: 80,
      },
    ]);
    const entry = fieldRendererRegistry.resolve(
      "hitl-field",
      { type: "object", "x-renderer": "@cinatra-ai/email-test-delivery-agent:input" },
      {
        runId: "run-3532",
        connectedApps: [],
        xRenderer: "@cinatra-ai/email-test-delivery-agent:input",
        allFieldValues: {},
      } as unknown as Parameters<typeof fieldRendererRegistry.resolve>[2],
    );
    expect(entry).not.toBeNull();
    expect(entry!.drawsOwnSubmit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cinatra#3562 — A RENDERER THAT REPORTS ITS VALUE UNSENDABLE HOLDS THE
// CONTINUE DRAWN FOR ITS GATE, on the setup road and mid-run alike.
// ---------------------------------------------------------------------------

/**
 * A pack-shaped list step that takes several picks: two boxes, nothing ticked
 * when it opens, and it reports through `onValidityChange` whether anything is
 * ticked. A string-typed input receives the ticks as JSON; any other input
 * receives the object itself.
 */
const TICKING_RENDERER_ID = "@cinatra-test/pack-agent:ticking";
/** The same, on a gate this panel classifies as mid-run (`:output`). */
const MID_RUN_TICKING_RENDERER_ID = "@cinatra-test/pack-agent-ticking:output";

function TickingRenderer({ schema, onChange, onValidityChange }: FieldRendererProps) {
  const [ticked, setTicked] = React.useState<string[]>([]);
  React.useEffect(() => {
    onValidityChange?.(ticked.length > 0);
  }, [onValidityChange, ticked]);
  const toggle = (id: string) => {
    const next = ticked.includes(id) ? ticked.filter((t) => t !== id) : [...ticked, id];
    setTicked(next);
    const picks = { type: "list", listIds: next, listNames: next.map((t) => `View ${t}`) };
    void onChange(schema.type === "string" ? JSON.stringify(picks) : picks);
  };
  return (
    <div>
      {["one", "two"].map((id) => (
        <Input
          key={id}
          type="checkbox"
          aria-label={`View ${id}`}
          checked={ticked.includes(id)}
          onChange={() => toggle(id)}
        />
      ))}
    </div>
  );
}

/** The same step drawn already ticked, by a renderer that never reports. */
function QuietTickedRenderer() {
  return <Input type="checkbox" aria-label="View one" checked readOnly />;
}

/** Puts `renderer` in place of the ticking one under its id. */
function replaceTickingRenderer(id: string, renderer: (props: FieldRendererProps) => React.ReactNode) {
  fieldRendererRegistry.register({
    id,
    priority: 100,
    condition: (_fieldName, schema) => (schema as { "x-renderer"?: unknown })["x-renderer"] === id,
    renderer,
  });
}

/**
 * A step that hands the test its report and its value, so that a report and a
 * press can run inside one act(): the press then reaches a Continue that is
 * still drawn available, and only the press-time check can stop it. The handle
 * is bound by the drawn step's own effect; until then, and in every new case
 * until it is bound again, a call through it throws rather than going nowhere
 * (or to the step a previous case drew). The step draws the value the panel
 * hands it back, so a case can read that its staging reached the panel.
 */
const stepHandle: {
  bound: boolean;
  report: (valid: boolean) => void;
  stage: (ids: string[]) => void;
} = { bound: false, report: () => {}, stage: () => {} };
function unbindStepHandle() {
  stepHandle.bound = false;
  stepHandle.report = () => {
    throw new Error("no Handle step is drawn yet");
  };
  stepHandle.stage = () => {
    throw new Error("no Handle step is drawn yet");
  };
}
unbindStepHandle();
function HandleRenderer({ schema, value, onChange, onValidityChange }: FieldRendererProps) {
  React.useEffect(() => {
    stepHandle.report = (valid) => onValidityChange?.(valid);
    stepHandle.stage = (ids) => {
      const picks = { type: "list", listIds: ids, listNames: ids.map((t) => `View ${t}`) };
      void onChange(schema.type === "string" ? JSON.stringify(picks) : picks);
    };
    stepHandle.bound = true;
  });
  return (
    <div>
      <p>Handle step</p>
      <p data-testid="handle-step-value">{typeof value === "string" ? value : ""}</p>
    </div>
  );
}

/**
 * A step that reports its value unsendable once, from a layout effect: that
 * runs in the commit that mounts it, before the renderer it replaces is
 * cleaned up, and it never reports again.
 */
function LayoutHeldRenderer({ onValidityChange }: FieldRendererProps) {
  React.useLayoutEffect(() => {
    onValidityChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one report, at mount
  }, []);
  return <p>Layout step</p>;
}

/**
 * A step that keeps its own state and reports only when that state changes:
 * nothing ticked at mount, so it reports `false` once, and again on a tick.
 */
const keptStep = { mounts: 0 };
function KeptStateRenderer({ onValidityChange }: FieldRendererProps) {
  const [ticked, setTicked] = React.useState(false);
  React.useEffect(() => {
    keptStep.mounts += 1;
  }, []);
  React.useEffect(() => {
    onValidityChange?.(ticked);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reports on a change of its own state only
  }, [ticked]);
  return (
    <Input type="checkbox" aria-label="View one" checked={ticked} onChange={() => setTicked(!ticked)} />
  );
}

/** Mount the panel, and move it to another gate the way the stream does. */
async function renderMovablePanel(options: { strict?: boolean } = {}) {
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  const draw = () =>
    options.strict === true ? (
      <React.StrictMode>
        <AgenticRunPanel {...PANEL_PROPS} />
      </React.StrictMode>
    ) : (
      <AgenticRunPanel {...PANEL_PROPS} />
    );
  const view = render(draw());
  const moveTo = async (
    xRenderer: string,
    fieldName: string,
    schema: Record<string, unknown>,
    reviewTaskId?: string,
  ) => {
    await setGate(xRenderer, fieldName, schema, reviewTaskId);
    view.rerender(draw());
  };
  return { ...view, moveTo };
}

describe("AgenticRunPanel — a renderer that reports its value unsendable (cinatra#3562)", () => {
  beforeEach(() => {
    unbindStepHandle();
    for (const id of [TICKING_RENDERER_ID, MID_RUN_TICKING_RENDERER_ID]) {
      fieldRendererRegistry.register({
        id,
        priority: 100,
        condition: (_fieldName, schema) =>
          (schema as { "x-renderer"?: unknown })["x-renderer"] === id,
        renderer: TickingRenderer,
      });
    }
  });

  it("holds the setup field's Continue while nothing is ticked and sends every tick once one is", async () => {
    await setGate(TICKING_RENDERER_ID, "accountScope", { type: "string" });
    const view = await renderPanel();

    await view.findByRole("checkbox", { name: "View one" });
    await waitFor(() => expect(productContinue()!.disabled).toBe(true));
    fireEvent.click(productContinue()!);
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("checkbox", { name: "View two" }));
    await waitFor(() => expect(productContinue()!.disabled).toBe(false));
    fireEvent.click(view.getByRole("checkbox", { name: "View two" }));
    await waitFor(() => expect(productContinue()!.disabled).toBe(true));

    fireEvent.click(view.getByRole("checkbox", { name: "View two" }));
    fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
    await waitFor(() => expect(productContinue()!.disabled).toBe(false));
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    fireEvent.click(productContinue()!);
    await waitFor(() =>
      expect(hitlActions.approveReviewTask).toHaveBeenCalledWith(
        "setup-run-3532",
        {
          accountScope: JSON.stringify({
            type: "list",
            listIds: ["two", "one"],
            listNames: ["View two", "View one"],
          }),
        },
        "accountScope",
      ),
    );
  });

  it("holds a mid-run gate's Continue while nothing is ticked and resumes with every tick", async () => {
    await setGate(MID_RUN_TICKING_RENDERER_ID, "accountScope", { type: "object" });
    const view = await renderPanel();

    await view.findByRole("checkbox", { name: "View one" });
    await waitFor(() => expect(productContinue()!.disabled).toBe(true));
    fireEvent.click(productContinue()!);
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("checkbox", { name: "View two" }));
    fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
    await waitFor(() => expect(productContinue()!.disabled).toBe(false));
    fireEvent.click(productContinue()!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const [taskId, payload] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(taskId).toBe("setup-run-3532");
    expect(payload).toMatchObject({
      type: "list",
      listIds: ["two", "one"],
      listNames: ["View two", "View one"],
      approved: true,
    });
  });

  it("a mid-run gate held again after a tick is taken back sends nothing until one is ticked", async () => {
    await setGate(MID_RUN_TICKING_RENDERER_ID, "accountScope", { type: "object" });
    const view = await renderPanel();

    await view.findByRole("checkbox", { name: "View one" });
    fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
    await waitFor(() => expect(productContinue()!.disabled).toBe(false));
    fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
    await waitFor(() => expect(productContinue()!.disabled).toBe(true));
    fireEvent.click(productContinue()!);
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("checkbox", { name: "View two" }));
    await waitFor(() => expect(productContinue()!.disabled).toBe(false));
    fireEvent.click(productContinue()!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const [, payload] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(payload).toMatchObject({ type: "list", listIds: ["two"], listNames: ["View two"] });
  });

  it("a report belongs to its own gate: the next gate, whose renderer reports nothing, is not held", async () => {
    await setGate(TICKING_RENDERER_ID, "accountScope", { type: "string" });
    const view = await renderMovablePanel();

    await view.findByRole("checkbox", { name: "View one" });
    await waitFor(() => expect(productContinue()!.disabled).toBe(true));
    await view.moveTo(CONTROL_LESS_RENDERER_ID, "callToAction", { type: "string" });
    await waitFor(() => expect(document.querySelector("#field-callToAction")).not.toBeNull());
    expect(productContinue()!.disabled).toBe(false);
  });

  it("a report leaves with its renderer: one that takes its place on the same gate and reports nothing is not held", async () => {
    await setGate(TICKING_RENDERER_ID, "accountScope", { type: "string" });
    const view = await renderMovablePanel();

    await view.findByRole("checkbox", { name: "View one" });
    await waitFor(() => expect(productContinue()!.disabled).toBe(true));
    replaceTickingRenderer(TICKING_RENDERER_ID, QuietTickedRenderer);
    await view.moveTo(TICKING_RENDERER_ID, "accountScope", { type: "string" });

    await waitFor(() =>
      expect((view.getByRole("checkbox", { name: "View one" }) as HTMLInputElement).checked).toBe(true),
    );
    await waitFor(() => expect(productContinue()!.disabled).toBe(false));
  });

  it("a gate drawn again, ticked, by a renderer that reports nothing is not held by the report made before", async () => {
    await setGate(TICKING_RENDERER_ID, "accountScope", { type: "string" });
    const view = await renderMovablePanel();

    await view.findByRole("checkbox", { name: "View one" });
    await waitFor(() => expect(productContinue()!.disabled).toBe(true));
    await view.moveTo(CONTROL_LESS_RENDERER_ID, "callToAction", { type: "string" });
    await waitFor(() => expect(document.querySelector("#field-callToAction")).not.toBeNull());
    replaceTickingRenderer(TICKING_RENDERER_ID, QuietTickedRenderer);
    await view.moveTo(TICKING_RENDERER_ID, "accountScope", { type: "string" });

    await waitFor(() =>
      expect((view.getByRole("checkbox", { name: "View one" }) as HTMLInputElement).checked).toBe(true),
    );
    await waitFor(() => expect(productContinue()!.disabled).toBe(false));
  });

  it("a setup field's Continue pressed in the same turn as a false report sends nothing", async () => {
    replaceTickingRenderer(TICKING_RENDERER_ID, HandleRenderer);
    await setGate(TICKING_RENDERER_ID, "accountScope", { type: "string" });
    const view = await renderPanel();

    await view.findByText("Handle step");
    await waitFor(() => expect(stepHandle.bound).toBe(true));
    act(() => stepHandle.stage(["one"]));
    // THE ANSWER IS STAGED: the panel hands the step back what it staged, so a
    // press that passed the hold would send it.
    await waitFor(() =>
      expect(view.getByTestId("handle-step-value").textContent).toBe(
        JSON.stringify({ type: "list", listIds: ["one"], listNames: ["View one"] }),
      ),
    );
    await waitFor(() => expect(productContinue()?.disabled).toBe(false));
    act(() => {
      stepHandle.report(false);
      // Still drawn available: only the press-time check can stop this press.
      expect(productContinue()!.disabled).toBe(false);
      fireEvent.click(productContinue()!);
    });
    await waitFor(() => expect(productContinue()?.disabled).toBe(true));
    act(() => {
      stepHandle.stage(["two"]);
      stepHandle.report(true);
    });
    await waitFor(() => expect(productContinue()?.disabled).toBe(false));
    fireEvent.click(productContinue()!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalled());
    expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1);
    expect(hitlActions.approveReviewTask).toHaveBeenNthCalledWith(
      1,
      "setup-run-3532",
      { accountScope: JSON.stringify({ type: "list", listIds: ["two"], listNames: ["View two"] }) },
      "accountScope",
    );
  });

  it("a mid-run gate's Continue pressed in the same turn as a false report sends nothing", async () => {
    replaceTickingRenderer(MID_RUN_TICKING_RENDERER_ID, HandleRenderer);
    await setGate(MID_RUN_TICKING_RENDERER_ID, "accountScope", { type: "object" });
    const view = await renderPanel();

    await view.findByText("Handle step");
    await waitFor(() => expect(stepHandle.bound).toBe(true));
    act(() => stepHandle.stage(["one"]));
    await waitFor(() => expect(productContinue()?.disabled).toBe(false));
    act(() => {
      stepHandle.report(false);
      // Still drawn available: only the press-time check can stop this press.
      expect(productContinue()!.disabled).toBe(false);
      fireEvent.click(productContinue()!);
    });
    await waitFor(() => expect(productContinue()?.disabled).toBe(true));
    act(() => {
      stepHandle.stage(["two"]);
      stepHandle.report(true);
    });
    await waitFor(() => expect(productContinue()?.disabled).toBe(false));
    fireEvent.click(productContinue()!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalled());
    expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1);
    const [taskId, payload] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(taskId).toBe("setup-run-3532");
    expect(payload).toMatchObject({ type: "list", listIds: ["two"], listNames: ["View two"], approved: true });
  });

  it("a held setup field's Continue is unavailable and carries no credential title", async () => {
    await setGate(TICKING_RENDERER_ID, "accountScope", { type: "string" });
    const view = await renderPanel();

    await view.findByRole("checkbox", { name: "View one" });
    await waitFor(() => expect(productContinue()!.disabled).toBe(true));
    expect(productContinue()!.hasAttribute("title")).toBe(false);
    fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
    await waitFor(() => expect(productContinue()!.disabled).toBe(false));
    expect(productContinue()!.hasAttribute("title")).toBe(false);
  });

  it("the composer sends nothing for a held gate, and sends once the gate is no longer held", async () => {
    const onActiveGateChange = vi.fn();
    await setGate(TICKING_RENDERER_ID, "accountScope", { type: "string" });
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const view = render(<AgenticRunPanel {...PANEL_PROPS} onActiveGateChange={onActiveGateChange} />);

    await view.findByRole("checkbox", { name: "View one" });
    await waitFor(() => expect(productContinue()!.disabled).toBe(true));
    const published = onActiveGateChange.mock.calls
      .map((call) => call[1] as { submit?: (value: string) => Promise<void> } | null)
      .filter((gate) => gate !== null);
    const gate = published[published.length - 1]!;
    expect(typeof gate.submit).toBe("function");
    await act(async () => {
      await gate.submit!("composer text");
    });
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
    await waitFor(() => expect(productContinue()!.disabled).toBe(false));
    await act(async () => {
      await gate.submit!("composer text");
    });
    expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1);
  });

  it("a renderer that takes the gate's place and reports false from a layout effect keeps it held", async () => {
    await setGate(TICKING_RENDERER_ID, "accountScope", { type: "string" });
    const view = await renderMovablePanel();

    await view.findByRole("checkbox", { name: "View one" });
    fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
    await waitFor(() => expect(productContinue()!.disabled).toBe(false));
    replaceTickingRenderer(TICKING_RENDERER_ID, LayoutHeldRenderer);
    await view.moveTo(TICKING_RENDERER_ID, "accountScope", { type: "string" });

    await view.findByText("Layout step");
    await waitFor(() => expect(productContinue()!.disabled).toBe(true));
    fireEvent.click(productContinue()!);
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });

  it("a gate of another review task with the same renderer and field gets a new renderer, which holds it", async () => {
    keptStep.mounts = 0;
    replaceTickingRenderer(TICKING_RENDERER_ID, KeptStateRenderer);
    await setGate(TICKING_RENDERER_ID, "accountScope", { type: "string" });
    const view = await renderMovablePanel();

    await view.findByRole("checkbox", { name: "View one" });
    await waitFor(() => expect(productContinue()!.disabled).toBe(true));
    await view.moveTo(TICKING_RENDERER_ID, "accountScope", { type: "string" }, "setup-run-3532-next");

    await waitFor(() => expect(keptStep.mounts).toBe(2));
    await waitFor(() => expect(productContinue()!.disabled).toBe(true));
    fireEvent.click(productContinue()!);
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
    await waitFor(() => expect(productContinue()!.disabled).toBe(false));
  });

  it("a report a renderer makes after it has left the screen holds nothing", async () => {
    replaceTickingRenderer(TICKING_RENDERER_ID, HandleRenderer);
    await setGate(TICKING_RENDERER_ID, "accountScope", { type: "string" });
    const view = await renderMovablePanel();

    await view.findByText("Handle step");
    await waitFor(() => expect(stepHandle.bound).toBe(true));
    act(() => stepHandle.stage(["one"]));
    await waitFor(() => expect(productContinue()?.disabled).toBe(false));
    const lateReport = stepHandle.report;
    replaceTickingRenderer(TICKING_RENDERER_ID, QuietTickedRenderer);
    await view.moveTo(TICKING_RENDERER_ID, "accountScope", { type: "string" });
    await waitFor(() =>
      expect((view.getByRole("checkbox", { name: "View one" }) as HTMLInputElement).checked).toBe(true),
    );
    await waitFor(() => expect(productContinue()!.disabled).toBe(false));

    act(() => lateReport(false));
    expect(productContinue()!.disabled).toBe(false);
  });

  it("under StrictMode a renderer's report holds its gate exactly while it is false, and leaves with it", async () => {
    await setGate(TICKING_RENDERER_ID, "accountScope", { type: "string" });
    const view = await renderMovablePanel({ strict: true });

    await view.findByRole("checkbox", { name: "View one" });
    await waitFor(() => expect(productContinue()!.disabled).toBe(true));
    fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
    await waitFor(() => expect(productContinue()!.disabled).toBe(false));
    fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
    await waitFor(() => expect(productContinue()!.disabled).toBe(true));
    fireEvent.click(productContinue()!);
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();

    replaceTickingRenderer(TICKING_RENDERER_ID, QuietTickedRenderer);
    await view.moveTo(TICKING_RENDERER_ID, "accountScope", { type: "string" });
    await waitFor(() =>
      expect((view.getByRole("checkbox", { name: "View one" }) as HTMLInputElement).checked).toBe(true),
    );
    await waitFor(() => expect(productContinue()!.disabled).toBe(false));
  });
});
