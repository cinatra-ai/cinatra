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

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  GROUPED_SETUP_FORM_RENDERER_ID,
  SCHEMA_FIELD_FALLBACK_RENDERER_ID,
} from "../agent-builder-ids";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { fieldRendererRegistry } from "../field-renderer-registry";
import type { FieldRendererProps } from "../field-renderer-registry";
import { makeExtensionFieldRenderer } from "../extension-field-renderer";
import {
  __resetFieldRendererComponentMapForTests,
  __setFieldRendererComponentMapForTests,
} from "../field-renderer-components";

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

/**
 * The run window hands the panel its files through `onSubmit`'s second
 * argument. The run page draws the window without its paperclip, so a test
 * that needs a waiting file adds one send control beside the real window, and
 * only while `windowFiles.attachments` is set.
 */
const windowFiles = vi.hoisted(() => ({ attachments: null as null | unknown[] }));
vi.mock("../hitl-conversation-panel", async (importOriginal) => {
  const real = await importOriginal<typeof import("../hitl-conversation-panel")>();
  const { Button: WindowButton } = await import("@/components/ui/button");
  function WindowWithAFile(props: React.ComponentProps<typeof real.HitlConversationPanel>) {
    return (
      <>
        <real.HitlConversationPanel {...props} />
        {windowFiles.attachments ? (
          <WindowButton
            type="button"
            onClick={() =>
              void props.onSubmit(
                "see attached",
                windowFiles.attachments as Parameters<typeof props.onSubmit>[1],
              )
            }
          >
            Send with a file
          </WindowButton>
        ) : null}
      </>
    );
  }
  return { ...real, HitlConversationPanel: WindowWithAFile };
});

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
/**
 * The same, on a list step: a `:list-picker` gate, which this panel classifies
 * as mid-run by its suffix, as the stepper does (cinatra#3562).
 */
const MID_RUN_TICKING_RENDERER_ID = "@cinatra-test/pack-agent-ticking:list-picker";
/** The same, on an `:output` gate, the other mid-run suffix. */
const OUTPUT_TICKING_RENDERER_ID = "@cinatra-test/pack-agent-ticking:output";
/** The email outreach agent's own list step binding: it declares no `midRunHitl`. */
const OUTREACH_LIST_PICKER_ID = "@cinatra-ai/email-outreach-agent:list-picker";

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
  /** The stream holds no gate for a moment, as between two review tasks. */
  const clearGate = async () => {
    const { useAgUiRunStream } = await import("../use-ag-ui-run-stream");
    (useAgUiRunStream as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      ...streamResultFor(CONTROL_LESS_RENDERER_ID, "callToAction", { type: "string" }),
      status: "running",
      interruptContext: null,
    });
    view.rerender(draw());
  };
  return { ...view, moveTo, clearGate };
}

describe("AgenticRunPanel — a renderer that reports its value unsendable (cinatra#3562)", () => {
  beforeEach(() => {
    unbindStepHandle();
    for (const id of [TICKING_RENDERER_ID, MID_RUN_TICKING_RENDERER_ID, OUTPUT_TICKING_RENDERER_ID]) {
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
    await setGate(MID_RUN_TICKING_RENDERER_ID, "accountScope", { type: "object" }, "review-run-3562");
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
    expect(taskId).toBe("review-run-3562");
    expect(payload).toMatchObject({
      type: "list",
      listIds: ["two", "one"],
      listNames: ["View two", "View one"],
      approved: true,
    });
    // THE LIST STEP'S NOTE (cinatra#3562): the Continue lifts every tick into
    // the approval note, in the order ticked, as the stepper's Continue does.
    expect(typeof payload.approvalNote).toBe("string");
    expect(JSON.parse(payload.approvalNote as string)).toMatchObject({
      type: "list",
      listIds: ["two", "one"],
      listNames: ["View two", "View one"],
    });
  });

  it("a mid-run gate held again after a tick is taken back sends nothing until one is ticked", async () => {
    await setGate(MID_RUN_TICKING_RENDERER_ID, "accountScope", { type: "object" }, "review-run-3562");
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
    expect(typeof payload.approvalNote).toBe("string");
    expect(JSON.parse(payload.approvalNote as string)).toMatchObject({
      type: "list",
      listIds: ["two"],
      listNames: ["View two"],
    });
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
    await setGate(MID_RUN_TICKING_RENDERER_ID, "accountScope", { type: "object" }, "review-run-3562");
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
    expect(taskId).toBe("review-run-3562");
    expect(payload).toMatchObject({ type: "list", listIds: ["two"], listNames: ["View two"], approved: true });
    expect(typeof payload.approvalNote).toBe("string");
    expect(JSON.parse(payload.approvalNote as string)).toMatchObject({
      type: "list",
      listIds: ["two"],
      listNames: ["View two"],
    });
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

// ---------------------------------------------------------------------------
// cinatra#3562, fold 2 — EVERY SEND OF A HELD GATE SENDS NOTHING: the list
// step's own binding, a renderer's own submit, a grouped form's submit, a
// report made while the press awaited the renderer's flush, and a component
// that crashes into the floor.
// ---------------------------------------------------------------------------

/**
 * A step that draws its OWN send, the way a renderer that declares
 * `drawsOwnSubmit` does: ticks kept in its own state, a report of whether
 * anything is ticked, and a "Send picks" button that hands the picks over
 * through `onChange`, which is the send on the roads it is drawn on.
 * It reports in a layout effect, so the report lands in the commit that draws
 * "Send picks": a case that finds the button and presses it at once never
 * presses before the first report (a report in a passive effect can come
 * after that press, and the press is then not held).
 */
function OwnSubmitRenderer({ schema, onChange, onValidityChange }: FieldRendererProps) {
  const [ticked, setTicked] = React.useState<string[]>([]);
  React.useLayoutEffect(() => {
    onValidityChange?.(ticked.length > 0);
  }, [onValidityChange, ticked]);
  const picks = { type: "list", listIds: ticked, listNames: ticked.map((t) => `View ${t}`) };
  return (
    <div>
      {["one", "two"].map((id) => (
        <Input
          key={id}
          type="checkbox"
          aria-label={`View ${id}`}
          checked={ticked.includes(id)}
          onChange={() =>
            setTicked(ticked.includes(id) ? ticked.filter((t) => t !== id) : [...ticked, id])
          }
        />
      ))}
      <Button
        type="button"
        onClick={() => void onChange(schema.type === "string" ? JSON.stringify(picks) : picks)}
      >
        Send picks
      </Button>
    </div>
  );
}

/**
 * A step that hands its value over only when the Continue asks for it (its
 * flush), and that reports its value unsendable during that flush: the press
 * read the gate as open, and the report arrives while the press awaits.
 */
function FlushReportsRenderer({ schema, onChange, onValidityChange, registerFlush }: FieldRendererProps) {
  React.useEffect(() => {
    onValidityChange?.(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one report, at mount
  }, []);
  React.useEffect(() => {
    registerFlush?.(async () => {
      onValidityChange?.(false);
      const picks = { type: "list", listIds: [], listNames: [] };
      await onChange(schema.type === "string" ? JSON.stringify(picks) : picks);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- registered once, at mount
  }, [registerFlush]);
  return <p>Flush step</p>;
}

/** The late report of a component that has crashed; set when it breaks. */
const crashed: { lateReport: ((valid: boolean) => void) | null } = { lateReport: null };
/** Reports nothing ticked, and throws while rendering once "Break" is pressed. */
function ReportsFalseThenThrows({ onValidityChange }: FieldRendererProps) {
  const [broken, setBroken] = React.useState(false);
  React.useEffect(() => {
    onValidityChange?.(false);
  }, [onValidityChange]);
  if (broken) throw new Error("render crash");
  return (
    <Button
      type="button"
      onClick={() => {
        crashed.lateReport = (valid) => onValidityChange?.(valid);
        setBroken(true);
      }}
    >
      Break
    </Button>
  );
}

/**
 * A list step like the shipped one: one pick, buffered by `listId`, and no
 * validity report.
 */
function SilentListRenderer({ onChange }: FieldRendererProps) {
  return (
    <div>
      <Button
        type="button"
        onClick={() => void onChange({ scope: "list", listId: "   ", listName: "Blank", memberCount: 0 })}
      >
        Pick blank
      </Button>
      <Button
        type="button"
        onClick={() => void onChange({ scope: "list", listId: "l1", listName: "List one", memberCount: 3 })}
      >
        Pick list one
      </Button>
    </div>
  );
}

describe("AgenticRunPanel — every send of a held gate sends nothing (cinatra#3562)", () => {
  beforeEach(() => {
    unbindStepHandle();
    crashed.lateReport = null;
    for (const id of [TICKING_RENDERER_ID, OUTPUT_TICKING_RENDERER_ID]) {
      fieldRendererRegistry.register({
        id,
        priority: 100,
        condition: (_fieldName, schema) =>
          (schema as { "x-renderer"?: unknown })["x-renderer"] === id,
        renderer: TickingRenderer,
      });
    }
  });

  it("draws the email outreach agent's own list step as a mid-run gate, holds it, and lifts every tick into the note", async () => {
    // THE PREMISE: the build's own binding for the step declares no
    // `midRunHitl` flag, so only the `:list-picker` suffix can make it mid-run.
    const shipped = fieldRendererRegistry.list().filter((e) => e.id === OUTREACH_LIST_PICKER_ID);
    expect(shipped).toHaveLength(1);
    expect(shipped[0]!.midRunHitl).not.toBe(true);
    // The stand-in takes its place the way an extension-shipped component does,
    // which keeps its own send (`drawsOwnSubmit: true`, the map-first branch).
    fieldRendererRegistry.register({
      id: OUTREACH_LIST_PICKER_ID,
      priority: 90,
      condition: (_fieldName, schema) =>
        (schema as { "x-renderer"?: unknown })["x-renderer"] === OUTREACH_LIST_PICKER_ID,
      renderer: TickingRenderer,
      drawsOwnSubmit: true,
    });
    await setGate(OUTREACH_LIST_PICKER_ID, "accountScope", { type: "object" }, "review-run-3562");
    const view = await renderPanel();

    await view.findByRole("checkbox", { name: "View one" });
    await waitFor(() => expect(productContinue()).not.toBeNull());
    await waitFor(() => expect(productContinue()!.disabled).toBe(true));
    fireEvent.click(productContinue()!);
    // A tick buffers for the Continue; it is not itself a send.
    fireEvent.click(view.getByRole("checkbox", { name: "View two" }));
    fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
    await waitFor(() => expect(productContinue()!.disabled).toBe(false));
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    fireEvent.click(productContinue()!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const [taskId, payload, fieldName] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      string | undefined,
    ];
    expect(taskId).toBe("review-run-3562");
    expect(fieldName).toBeUndefined();
    expect(payload).toMatchObject({ approved: true });
    expect(typeof payload.approvalNote).toBe("string");
    const note = JSON.parse(payload.approvalNote as string) as Record<string, unknown>;
    expect(note).toMatchObject({
      type: "list",
      listIds: ["two", "one"],
      listNames: ["View two", "View one"],
    });
    expect(typeof note.snapshotAt).toBe("string");
    expect(note).not.toHaveProperty("listId");
  });

  it("keeps a list step on a setup gate on the setup road: its answer goes under the gate's field name", async () => {
    fieldRendererRegistry.register({
      id: MID_RUN_TICKING_RENDERER_ID,
      priority: 100,
      condition: (_fieldName, schema) =>
        (schema as { "x-renderer"?: unknown })["x-renderer"] === MID_RUN_TICKING_RENDERER_ID,
      renderer: TickingRenderer,
    });
    await setGate(MID_RUN_TICKING_RENDERER_ID, "accountScope", { type: "object" });
    const view = await renderPanel();

    await view.findByRole("checkbox", { name: "View one" });
    await waitFor(() => expect(productContinue()!.disabled).toBe(true));
    fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
    await waitFor(() => expect(productContinue()!.disabled).toBe(false));
    fireEvent.click(productContinue()!);
    await waitFor(() =>
      expect(hitlActions.approveReviewTask).toHaveBeenCalledWith(
        "setup-run-3532",
        { accountScope: { type: "list", listIds: ["one"], listNames: ["View one"] } },
        "accountScope",
      ),
    );
  });

  it("holds an `:output` gate's Continue the same way", async () => {
    await setGate(OUTPUT_TICKING_RENDERER_ID, "accountScope", { type: "object" });
    const view = await renderPanel();

    await view.findByRole("checkbox", { name: "View one" });
    await waitFor(() => expect(productContinue()!.disabled).toBe(true));
    fireEvent.click(productContinue()!);
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
    await waitFor(() => expect(productContinue()!.disabled).toBe(false));
    fireEvent.click(productContinue()!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
  });

  it("a list step that reports nothing sends nothing while nothing is picked, and resumes with its pick in the note", async () => {
    const SILENT_LIST_ID = "@cinatra-test/pack-agent-silent:list-picker";
    fieldRendererRegistry.register({
      id: SILENT_LIST_ID,
      priority: 100,
      condition: (_fieldName, schema) =>
        (schema as { "x-renderer"?: unknown })["x-renderer"] === SILENT_LIST_ID,
      renderer: SilentListRenderer,
    });
    await setGate(SILENT_LIST_ID, "accountScope", { type: "object" }, "review-run-3562");
    const view = await renderPanel();

    await view.findByRole("button", { name: "Pick list one" });
    await waitFor(() => expect(productContinue()).not.toBeNull());
    // Nothing reports, so the Continue stays drawn; with nothing picked a
    // press sends nothing (no `approved: true`, no empty snapshot).
    expect(productContinue()!.disabled).toBe(false);
    fireEvent.click(productContinue()!);
    await act(async () => {});
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    // A blank id is no pick either.
    fireEvent.click(view.getByRole("button", { name: "Pick blank" }));
    await act(async () => {});
    fireEvent.click(productContinue()!);
    await act(async () => {});
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("button", { name: "Pick list one" }));
    await act(async () => {});
    fireEvent.click(productContinue()!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const [taskId, payload] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(taskId).toBe("review-run-3562");
    expect(payload).toMatchObject({ approved: true, listId: "l1" });
    expect(typeof payload.approvalNote).toBe("string");
    expect(JSON.parse(payload.approvalNote as string)).toMatchObject({
      type: "list",
      listId: "l1",
      listName: "List one",
      memberCount: 3,
    });
  });

  for (const [what, xRenderer, flagged] of [
    ["an `:output` gate", OUTPUT_TICKING_RENDERER_ID, false],
    [
      "a gate flagged mid-run whose renderer the stepper lifts",
      "@cinatra-test/pack-agent-ticking:scrape-schema-review",
      true,
    ],
  ] as const) {
    it(`lifts no approval note on ${what}: the run panel lifts the list step only`, async () => {
      if (flagged) {
        fieldRendererRegistry.register({
          id: xRenderer,
          priority: 100,
          condition: (_fieldName, schema) =>
            (schema as { "x-renderer"?: unknown })["x-renderer"] === xRenderer,
          renderer: TickingRenderer,
          midRunHitl: true,
        });
      }
      await setGate(xRenderer, "accountScope", { type: "object" }, "review-run-3562");
      const view = await renderPanel();

      await view.findByRole("checkbox", { name: "View one" });
      fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
      await waitFor(() => expect(productContinue()!.disabled).toBe(false));
      fireEvent.click(productContinue()!);
      await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
      const [taskId, payload] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(taskId).toBe("review-run-3562");
      expect(payload).toMatchObject({ approved: true, listIds: ["one"] });
      expect(payload).not.toHaveProperty("approvalNote");
    });
  }

  it("a renderer's own submit sends nothing while it reports its value unsendable", async () => {
    const OWN_SUBMIT_ID = "@cinatra-test/pack-agent:own-submit";
    fieldRendererRegistry.register({
      id: OWN_SUBMIT_ID,
      priority: 100,
      condition: (_fieldName, schema) =>
        (schema as { "x-renderer"?: unknown })["x-renderer"] === OWN_SUBMIT_ID,
      renderer: OwnSubmitRenderer,
      drawsOwnSubmit: true,
    });
    await setGate(OWN_SUBMIT_ID, "accountScope", { type: "string" });
    const view = await renderPanel();

    const send = await view.findByRole("button", { name: "Send picks" });
    // The renderer keeps its own send: the product draws no Continue beside it.
    expect(productContinue()).toBeNull();
    fireEvent.click(send);
    await act(async () => {});
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
    await act(async () => {});
    fireEvent.click(view.getByRole("button", { name: "Send picks" }));
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    expect(hitlActions.approveReviewTask).toHaveBeenCalledWith(
      "setup-run-3532",
      { accountScope: JSON.stringify({ type: "list", listIds: ["one"], listNames: ["View one"] }) },
      "accountScope",
    );
  });

  for (const [road, xRenderer] of [
    ["a grouped form", GROUPED_SETUP_FORM_RENDERER_ID],
    ["a mid-run grouped form", `${GROUPED_SETUP_FORM_RENDERER_ID}:output`],
  ] as const) {
    it(`${road}'s own submit sends nothing while it reports its value unsendable`, async () => {
      fieldRendererRegistry.register({
        id: xRenderer,
        priority: 100,
        condition: (_fieldName, schema) =>
          (schema as { "x-renderer"?: unknown })["x-renderer"] === xRenderer,
        renderer: OwnSubmitRenderer,
      });
      await setGate(xRenderer, "accountScope", { type: "object" });
      const view = await renderPanel();

      const send = await view.findByRole("button", { name: "Send picks" });
      fireEvent.click(send);
      await act(async () => {});
      expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();

      fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
      await act(async () => {});
      fireEvent.click(view.getByRole("button", { name: "Send picks" }));
      await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
      const [taskId] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [string];
      expect(taskId).toBe("setup-run-3532");
    });
  }

  it("a setup field's Continue sends nothing when the renderer reports false during the flush it awaits", async () => {
    replaceTickingRenderer(TICKING_RENDERER_ID, FlushReportsRenderer);
    await setGate(TICKING_RENDERER_ID, "accountScope", { type: "string" });
    const view = await renderPanel();

    await view.findByText("Flush step");
    await waitFor(() => expect(productContinue()?.disabled).toBe(false));
    // Open when pressed; the flush stages a value and reports false while the
    // press awaits it.
    fireEvent.click(productContinue()!);
    await waitFor(() => expect(productContinue()?.disabled).toBe(true));
    await act(async () => {});
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });

  it("a component that reported false and crashes into the floor keeps its gate held, and its late report frees nothing", async () => {
    // React reports the caught render throw; the wrapper logs it as well.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const WRAPPED_ID = "@cinatra-test/pack-agent:crash-wrapped";
    __setFieldRendererComponentMapForTests({
      [WRAPPED_ID]: {
        resolution: "guardedOptional",
        packageName: "@cinatra-test/pack-agent",
        propsApiVersion: 1,
        load: async () => ({ default: ReportsFalseThenThrows }),
      },
    });
    try {
      fieldRendererRegistry.register({
        id: WRAPPED_ID,
        priority: 100,
        condition: (_fieldName, schema) =>
          (schema as { "x-renderer"?: unknown })["x-renderer"] === WRAPPED_ID,
        renderer: makeExtensionFieldRenderer(WRAPPED_ID),
      });
      await setGate(WRAPPED_ID, "accountScope", { type: "string" });
      const view = await renderPanel();

      const breakButton = await view.findByRole("button", { name: "Break" });
      await waitFor(() => expect(productContinue()!.disabled).toBe(true));
      fireEvent.click(breakButton);

      // The floor replaces the component; the false report it made stands.
      await waitFor(() => expect(view.queryByRole("button", { name: "Break" })).toBeNull());
      await waitFor(() => expect(document.querySelector("#field-accountScope")).not.toBeNull());
      await act(async () => {});
      expect(productContinue()!.disabled).toBe(true);

      // A report the crashed component makes afterwards changes nothing.
      expect(crashed.lateReport).not.toBeNull();
      act(() => crashed.lateReport!(true));
      await act(async () => {});
      expect(productContinue()!.disabled).toBe(true);
      fireEvent.click(productContinue()!);
      await act(async () => {});
      expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    } finally {
      __resetFieldRendererComponentMapForTests();
      quiet.mockRestore();
    }
  });

  it("a held report keeps a per-field boolean Continue unavailable: the floor a crashed component leaves draws it disabled (cinatra#4310)", async () => {
    // The register-default-renderers road gives every extension-shipped
    // component `drawsOwnSubmit: true`, so the product draws no Continue. When
    // such a component reports false and crashes, the floor draws the boolean
    // question with its own Continue (cinatra#4310). The false report stands,
    // so that Continue is unavailable too: disabled, and a press sends nothing.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const WRAPPED_ID = "@cinatra-test/pack-agent:crash-wrapped-boolean";
    __setFieldRendererComponentMapForTests({
      [WRAPPED_ID]: {
        resolution: "guardedOptional",
        packageName: "@cinatra-test/pack-agent",
        propsApiVersion: 1,
        load: async () => ({ default: ReportsFalseThenThrows }),
      },
    });
    /** The Continue buttons the field draws itself (not the product's). */
    const ownContinues = () =>
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter(
        (b) =>
          /Continue|Submitting/.test(b.textContent ?? "") &&
          b.getAttribute("data-action") !== "submit-hitl-screen",
      );
    try {
      fieldRendererRegistry.register({
        id: WRAPPED_ID,
        priority: 100,
        condition: (_fieldName, schema) =>
          (schema as { "x-renderer"?: unknown })["x-renderer"] === WRAPPED_ID,
        renderer: makeExtensionFieldRenderer(WRAPPED_ID),
        drawsOwnSubmit: true,
      });
      await setGate(WRAPPED_ID, "acceptTerms", { type: "boolean" });
      const view = await renderPanel();

      const breakButton = await view.findByRole("button", { name: "Break" });
      expect(productContinue()).toBeNull();
      fireEvent.click(breakButton);

      // The floor replaces the component and draws the boolean's own Continue.
      await waitFor(() => expect(view.queryByRole("button", { name: "Break" })).toBeNull());
      await waitFor(() => expect(document.querySelector("#field-acceptTerms")).not.toBeNull());
      await waitFor(() => expect(ownContinues()).toHaveLength(1));
      await act(async () => {});
      expect(productContinue()).toBeNull();
      expect(ownContinues()[0]!.disabled).toBe(true);
      fireEvent.click(ownContinues()[0]!);
      await act(async () => {});
      expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();

      // A report the crashed component makes afterwards frees nothing.
      expect(crashed.lateReport).not.toBeNull();
      act(() => crashed.lateReport!(true));
      await act(async () => {});
      expect(ownContinues()[0]!.disabled).toBe(true);
      fireEvent.click(ownContinues()[0]!);
      await act(async () => {});
      expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    } finally {
      __resetFieldRendererComponentMapForTests();
      quiet.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// cinatra#3562, fold 3 — Codex pre-review 2, MUST-FIX 1 to 3.
// ---------------------------------------------------------------------------

/** A list step that hands over its pick together with a reply text. */
function ReplyListRenderer({ onChange }: FieldRendererProps) {
  return (
    <Button
      type="button"
      onClick={() =>
        void onChange({ listIds: ["L1"], listNames: ["One"], userResponse: "continue" })
      }
    >
      Pick with a reply
    </Button>
  );
}

describe("AgenticRunPanel — one gate's state and answer stay with that gate (cinatra#3562, fold 3)", () => {
  it("a gate whose parts join to another gate's `::` string gets its own renderer, draft and answer (MUST-FIX 1)", async () => {
    // Gate A: task `setup-a`, field `b::<R>::c`. Gate B: task `setup-a::<R>::b`,
    // field `c`. Joined with `::`, both read `setup-a::<R>::b::<R>::c`.
    const R = CONTROL_LESS_RENDERER_ID;
    const fieldA = `b::${R}::c`;
    expect(["setup-a", R, fieldA].join("::")).toBe([`setup-a::${R}::b`, R, "c"].join("::"));
    await setGate(R, fieldA, { type: "string" }, "setup-a");
    const view = await renderMovablePanel();

    const boxA = () => document.getElementById(`field-${fieldA}`) as HTMLInputElement | null;
    await waitFor(() => expect(boxA()).not.toBeNull());
    fireEvent.change(boxA()!, { target: { value: "for A" } });
    await waitFor(() => expect(boxA()!.value).toBe("for A"));

    await view.moveTo(R, "c", { type: "string" }, `setup-a::${R}::b`);
    const boxB = () => document.getElementById("field-c") as HTMLInputElement | null;
    await waitFor(() => expect(boxB()).not.toBeNull());
    // B is a question of its own: it starts empty, and a press sends nothing.
    expect(boxB()!.value).toBe("");
    fireEvent.click(productContinue()!);
    await act(async () => {});
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });

  it("a list step of the next review task starts with no pick: the earlier task's pick is never sent for it (MUST-FIX 2)", async () => {
    const SILENT_LIST_ID = "@cinatra-test/pack-agent-silent:list-picker";
    fieldRendererRegistry.register({
      id: SILENT_LIST_ID,
      priority: 100,
      condition: (_fieldName, schema) =>
        (schema as { "x-renderer"?: unknown })["x-renderer"] === SILENT_LIST_ID,
      renderer: SilentListRenderer,
    });
    await setGate(SILENT_LIST_ID, "accountScope", { type: "object" }, "review-run-3562-a");
    const view = await renderMovablePanel();

    await view.findByRole("button", { name: "Pick list one" });
    fireEvent.click(view.getByRole("button", { name: "Pick list one" }));
    await act(async () => {});

    // Task A is answered elsewhere; the stream holds no gate, then task B
    // arrives on the same renderer and field.
    await view.clearGate();
    await view.moveTo(SILENT_LIST_ID, "accountScope", { type: "object" }, "review-run-3562-b");
    await view.findByRole("button", { name: "Pick list one" });
    await waitFor(() => expect(productContinue()).not.toBeNull());
    fireEvent.click(productContinue()!);
    await act(async () => {});
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });

  it("a list step's pick is the resume text: a buffered reply text does not ride along to shadow it (MUST-FIX 3)", async () => {
    const REPLY_LIST_ID = "@cinatra-test/pack-agent-reply:list-picker";
    fieldRendererRegistry.register({
      id: REPLY_LIST_ID,
      priority: 100,
      condition: (_fieldName, schema) =>
        (schema as { "x-renderer"?: unknown })["x-renderer"] === REPLY_LIST_ID,
      renderer: ReplyListRenderer,
    });
    await setGate(REPLY_LIST_ID, "accountScope", { type: "object" }, "review-run-3562");
    const view = await renderPanel();

    await view.findByRole("button", { name: "Pick with a reply" });
    fireEvent.click(view.getByRole("button", { name: "Pick with a reply" }));
    await act(async () => {});
    await waitFor(() => expect(productContinue()).not.toBeNull());
    fireEvent.click(productContinue()!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const [taskId, payload] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(taskId).toBe("review-run-3562");
    expect(payload).not.toHaveProperty("userResponse");
    expect(JSON.parse(payload.approvalNote as string)).toMatchObject({
      type: "list",
      listIds: ["L1"],
      listNames: ["One"],
    });
  });

  it("with a file waiting, the attachment envelope wraps the list step's note, not a default text (MUST-FIX 3)", async () => {
    const REPLY_LIST_ID = "@cinatra-test/pack-agent-reply-file:list-picker";
    fieldRendererRegistry.register({
      id: REPLY_LIST_ID,
      priority: 100,
      condition: (_fieldName, schema) =>
        (schema as { "x-renderer"?: unknown })["x-renderer"] === REPLY_LIST_ID,
      renderer: ReplyListRenderer,
    });
    windowFiles.attachments = [
      {
        artifactId: "art-1",
        representationRevisionId: "ver-1",
        digest: "sha256:abc",
        mime: "application/pdf",
        originKind: "upload",
        filename: "report.pdf",
      },
    ];
    try {
      await setGate(REPLY_LIST_ID, "accountScope", { type: "object" }, "review-run-3562");
      // Without a template the window's message stops in the panel after it
      // keeps the files: nothing goes to the run's conversation.
      const propsWithoutTemplate = { ...PANEL_PROPS, templateId: undefined };
      const { AgenticRunPanel } = await import("../agentic-run-panel");
      const view = render(<AgenticRunPanel {...propsWithoutTemplate} />);

      await view.findByRole("button", { name: "Pick with a reply" });
      fireEvent.click(view.getByRole("button", { name: "Pick with a reply" }));
      fireEvent.click(view.getByRole("button", { name: "Send with a file" }));
      await act(async () => {});
      await waitFor(() => expect(productContinue()).not.toBeNull());
      fireEvent.click(productContinue()!);
      await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
      const [taskId, payload] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(taskId).toBe("review-run-3562");
      const envelope = JSON.parse(payload.userResponse as string) as {
        text: string;
        attachments: Array<{ artifactId: string }>;
      };
      expect(envelope.attachments.map((a) => a.artifactId)).toEqual(["art-1"]);
      // The run reads the envelope's text: it is the list step's note.
      expect(envelope.text).toBe(payload.approvalNote);
      expect(JSON.parse(envelope.text)).toMatchObject({
        type: "list",
        listIds: ["L1"],
        listNames: ["One"],
      });
    } finally {
      windowFiles.attachments = null;
    }
  });
});
