// @vitest-environment jsdom
/**
 * THE PER-FIELD SETUP GATE AN EXTENSION RENDERER DRAWS (cinatra#3358).
 *
 * The checklist sentence this file answers, verbatim:
 *
 *   "a per-field setup gate whose field is drawn by an extension renderer
 *    draws the host's Continue, submits on Continue only and persists the
 *    value so the run advances — pinned red-first by a rendered test with a
 *    fake extension-drawn text field"
 *
 * THE MEASURED WALL: a setup field bound to an extension-declared renderer that
 * draws only its input — no Continue, no Next, no start control anywhere in the
 * run-detail column — left the reader with nothing to press, while every
 * keystroke went straight out as an approval. The first one moved the run out of
 * `pending_approval`, so every later one was refused, the reader's text was
 * never held anywhere, and the same gate came back for ever.
 *
 * The fake binding below is deliberately NOT any shipped package: the rule under
 * test is the host's, and it must hold for a renderer this repository has never
 * read.
 *
 *   pnpm vitest run \
 *     packages/agents/src/__tests__/orchestrator-stepper-extension-setup-gate.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

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
    ownKeys: () => ["AlertCircle", "ArrowRight", "Check", "Loader2", "Pause", "X", "default"],
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

vi.mock("@/lib/generated/field-renderer-components", () => ({
  GENERATED_FIELD_RENDERER_COMPONENTS: {},
}));

vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_MANIFEST: {},
  GENERATED_CONNECTOR_ENTRY_MODULES: {},
  GENERATED_CONNECTOR_MCP_MODULES: {},
  GENERATED_DEV_SETUP_MODULES: {},
  GENERATED_WIDGET_STREAM_AGENTS: {},
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
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true })),
  decideRunRecommendationAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

vi.mock("../run-name-actions", () => ({
  ensureOrCheckRunNameAction: vi.fn(async () => ({ ok: true, title: "Run 1" })),
}));

const approveReviewTask = vi.fn(async () => ({ ok: true }));
vi.mock("../hitl-actions", () => ({
  approveReviewTask: (...args: unknown[]) =>
    (approveReviewTask as unknown as (...a: unknown[]) => unknown)(...args),
}));

vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));

let interruptContext: {
  schema: Record<string, unknown>;
  xRenderer: string;
  values: Record<string, unknown>;
  reviewTaskId: string;
  fieldName?: string;
} | null = null;

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: (_runId: string, opts: { initialStatus?: string }) => ({
    status: opts?.initialStatus ?? "pending_approval",
    interruptContext,
    lifecycleInterrupt: null,
    messages: [],
    streamedText: "",
    presentationHint: null,
    dataPartFrames: [],
    isLive: true,
    error: null,
  }),
}));

// ---------------------------------------------------------------------------
// The fake extension-drawn text field — an input and NOTHING else, the shape the
// wall was measured on. It reports its own props so the contract the host hands
// it (`hideSubmit`) is readable from the test.
// ---------------------------------------------------------------------------

const FAKE_BINDING_ID = "@acme-example/fake-agent:note";
let lastRendererProps: Record<string, unknown> = {};

function FakeExtensionTextRenderer(props: Record<string, unknown>) {
  lastRendererProps = props;
  const value = typeof props.value === "string" ? (props.value as string) : "";
  const onChange = props.onChange as (next: unknown) => void;
  return (
    <Textarea
      data-testid="fake-extension-field"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

// ---------------------------------------------------------------------------
// THE OTHER SHAPE OF RENDERER THE HOST MUST BE ABLE TO DRIVE (convergence).
//
// The shipped schema floor `SchemaOnlyFloorRenderer` — what an extension
// binding draws while it loads, and whatever it degrades to — holds the
// reader's text in LOCAL state, honours `hideSubmit`, and reports the text only
// from the button it has just been told not to draw, through `registerFlush`.
// Taking that button away without asking through that seam submits an empty
// answer under visibly typed text.
// ---------------------------------------------------------------------------

const FLUSH_BINDING_ID = "@acme-example/fake-agent:flush-note";

function FakeFlushOnlyRenderer(props: Record<string, unknown>) {
  lastRendererProps = props;
  const [local, setLocal] = React.useState("");
  const localRef = React.useRef("");
  localRef.current = local;
  const onChange = props.onChange as (next: unknown) => void;
  const registerFlush = props.registerFlush as
    | ((fn: () => Promise<void>) => void)
    | undefined;
  React.useEffect(() => {
    if (!registerFlush) return;
    registerFlush(async () => {
      onChange(localRef.current);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerFlush]);
  return (
    <div>
      <Textarea
        data-testid="fake-flush-field"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
      />
      {props.hideSubmit === true ? null : (
        <Button type="button" onClick={() => onChange(localRef.current)}>
          Own Continue
        </Button>
      )}
    </div>
  );
}

type RegistryEntry = import("../field-renderer-registry").FieldRendererEntry;
let registrySnapshot: readonly RegistryEntry[] = [];

beforeEach(async () => {
  const { fieldRendererRegistry } = await import("../field-renderer-registry");
  registrySnapshot = fieldRendererRegistry.list().slice();
  fieldRendererRegistry.register({
    id: FAKE_BINDING_ID,
    priority: 500,
    condition: (_f, _s, ctx) => ctx.xRenderer === FAKE_BINDING_ID,
    renderer: FakeExtensionTextRenderer as unknown as RegistryEntry["renderer"],
  });
});

afterEach(async () => {
  cleanup();
  // RESTORE WHAT THIS FILE MOCKED — the registry is a module-global, so the fake
  // binding must not outlive the file that registered it.
  const { fieldRendererRegistry } = await import("../field-renderer-registry");
  fieldRendererRegistry.clear();
  for (const entry of registrySnapshot) fieldRendererRegistry.register(entry);
  registrySnapshot = [];
  lastRendererProps = {};
  interruptContext = null;
  approveReviewTask.mockClear();
  vi.clearAllMocks();
});

type PanelProps = import("../orchestrator-stepper-panel").OrchestratorStepperPanelProps;

function baseProps(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    runId: "run-3358",
    initialStatus: "pending_approval",
    initialError: null,
    agUiEnabled: true as boolean | null,
    agentPackageName: "@acme-example/fake-agent",
    inputParams: {},
    stepperSteps: [
      {
        index: 1,
        stepNumber: 0,
        label: "Setup",
        xRenderer: FAKE_BINDING_ID,
        description: "Collect the run's declared inputs",
      },
    ],
    agentId: "acme-example/fake-agent",
    lgThreadId: null,
    templateId: "tmpl-3358",
    templateName: "Fake agent",
    ...overrides,
  };
}

function continueButton(): HTMLButtonElement | null {
  return (
    (Array.from(document.querySelectorAll("button")).find((b) =>
      /^continue/i.test((b.textContent ?? "").trim()),
    ) as HTMLButtonElement | undefined) ?? null
  );
}

function field(): HTMLTextAreaElement {
  return document.querySelector(
    "[data-testid='fake-extension-field']",
  ) as HTMLTextAreaElement;
}

async function renderSetupGate() {
  interruptContext = {
    schema: { type: "string", "x-renderer": FAKE_BINDING_ID },
    xRenderer: FAKE_BINDING_ID,
    values: {},
    reviewTaskId: "setup-run-3358",
    fieldName: "callToAction",
  };
  const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
  render(<OrchestratorStepperPanel {...baseProps()} />);
  await waitFor(() => expect(field()).not.toBeNull());
}

describe('"draws the host\'s Continue"', () => {
  it("gives the step an advance control the extension renderer never drew", async () => {
    await renderSetupGate();
    await waitFor(() => expect(continueButton()).not.toBeNull());
    expect(continueButton()!.disabled).toBe(false);
  });

  it("tells the renderer the host owns the control, through the shared props contract", async () => {
    await renderSetupGate();
    await waitFor(() => expect(field()).not.toBeNull());
    expect(lastRendererProps.hideSubmit).toBe(true);
  });
});

describe('"submits on Continue only"', () => {
  it("sends nothing while the reader is still typing", async () => {
    await renderSetupGate();
    fireEvent.change(field(), { target: { value: "B" } });
    fireEvent.change(field(), { target: { value: "Bo" } });
    fireEvent.change(field(), { target: { value: "Book a meeting" } });
    await waitFor(() => expect(field().value).toBe("Book a meeting"));
    expect(approveReviewTask).not.toHaveBeenCalled();
  });

  it("holds the reader's text instead of dropping it between keystrokes", async () => {
    await renderSetupGate();
    fireEvent.change(field(), { target: { value: "Book a meeting" } });
    await waitFor(() => expect(field().value).toBe("Book a meeting"));
  });
});

describe('"persists the value so the run advances"', () => {
  it("submits once, carrying the value under the gate's own field name", async () => {
    await renderSetupGate();
    fireEvent.change(field(), { target: { value: "Book a meeting" } });
    await waitFor(() => expect(field().value).toBe("Book a meeting"));
    await waitFor(() => expect(continueButton()).not.toBeNull());
    fireEvent.click(continueButton()!);

    await waitFor(() => expect(approveReviewTask).toHaveBeenCalledTimes(1));
    const [taskId, payload] = approveReviewTask.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(taskId).toBe("setup-run-3358");
    expect(payload.callToAction).toBe("Book a meeting");
  });
});

describe("the floor keeps the control it has always had", () => {
  it("leaves a setup field on the host's schema-field fallback submitting through its own control", async () => {
    // REGRESSION GUARD. The fallback renderer owns its own Continue and treats
    // `onChange` as the submit; the new rule must not reach it, or that press
    // would buffer into a control the reader cannot see.
    const { SCHEMA_FIELD_FALLBACK_RENDERER_ID } = await import("../agent-builder-ids");
    const { fieldRendererRegistry } = await import("../field-renderer-registry");
    fieldRendererRegistry.register({
      id: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
      priority: 400,
      condition: (_f, _s, ctx) => ctx.xRenderer === SCHEMA_FIELD_FALLBACK_RENDERER_ID,
      renderer: FakeExtensionTextRenderer as unknown as RegistryEntry["renderer"],
    });
    interruptContext = {
      schema: { type: "string", "x-renderer": SCHEMA_FIELD_FALLBACK_RENDERER_ID },
      xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
      values: {},
      reviewTaskId: "setup-run-3358",
      fieldName: "callToAction",
    };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);
    await waitFor(() => expect(field()).not.toBeNull());

    fireEvent.change(field(), { target: { value: "Book a meeting" } });
    await waitFor(() => expect(approveReviewTask).toHaveBeenCalledTimes(1));
    expect(lastRendererProps.hideSubmit).toBeFalsy();
  });
});

describe("the press refuses what it cannot send", () => {
  it("sends nothing when the reader presses Continue with no answer staged", async () => {
    // THE PRESS THE HOST'S OWN CONTROL MADE POSSIBLE. The server's setup branch
    // strips the approval envelope, finds nothing left to merge, flips the run
    // to `queued` anyway and re-enqueues the setup loop — which asks the same
    // required field again. That is the very loop this fix exists to end,
    // reached through the control the fix added, so the press is refused here.
    const { toast } = await import("@/lib/cinatra-toast");
    await renderSetupGate();
    await waitFor(() => expect(continueButton()).not.toBeNull());
    fireEvent.click(continueButton()!);

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(approveReviewTask).not.toHaveBeenCalled();
    // The step is left exactly where the reader left it.
    expect(field()).not.toBeNull();
  });
});

describe("the answer goes out on the path this gate family always used", () => {
  it("names the gate's own field on the wire, so the single-field merge runs", async () => {
    // The per-keystroke fallback this fix replaced passed `payloadFieldName` as
    // the third argument, i.e. the server's SINGLE-FIELD path, which merges
    // `jsonb_build_object(fieldName, value)` and validates against the RESOLVED
    // template schema. The grouped path instead allowlists the submitted keys
    // against the STORED schema — stale-empty for a documented class of
    // installed templates — and strips a declared input named `approvalNote`.
    await renderSetupGate();
    fireEvent.change(field(), { target: { value: "Book a meeting" } });
    await waitFor(() => expect(field().value).toBe("Book a meeting"));
    fireEvent.click(continueButton()!);

    await waitFor(() => expect(approveReviewTask).toHaveBeenCalledTimes(1));
    const [taskId, payload, payloadFieldName] = approveReviewTask.mock
      .calls[0] as unknown as [string, Record<string, unknown>, unknown];
    expect(taskId).toBe("setup-run-3358");
    expect(payloadFieldName).toBe("callToAction");
    expect(payload.callToAction).toBe("Book a meeting");
  });
});

describe("a renderer that holds the reader's text locally is asked for it", () => {
  it("flushes the field before submitting, instead of sending an empty answer under typed text", async () => {
    const { fieldRendererRegistry } = await import("../field-renderer-registry");
    fieldRendererRegistry.register({
      id: FLUSH_BINDING_ID,
      priority: 500,
      condition: (_f, _s, ctx) => ctx.xRenderer === FLUSH_BINDING_ID,
      renderer: FakeFlushOnlyRenderer as unknown as RegistryEntry["renderer"],
    });
    interruptContext = {
      schema: { type: "string", "x-renderer": FLUSH_BINDING_ID },
      xRenderer: FLUSH_BINDING_ID,
      values: {},
      reviewTaskId: "setup-run-3358",
      fieldName: "callToAction",
    };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);
    const flushField = () =>
      document.querySelector("[data-testid='fake-flush-field']") as HTMLTextAreaElement;
    await waitFor(() => expect(flushField()).not.toBeNull());

    // Its own control is gone — the host owns the step.
    expect(lastRendererProps.hideSubmit).toBe(true);
    expect(
      Array.from(document.querySelectorAll("button")).some((b) =>
        /own continue/i.test((b.textContent ?? "").trim()),
      ),
    ).toBe(false);

    fireEvent.change(flushField(), { target: { value: "Book a meeting" } });
    await waitFor(() => expect(flushField().value).toBe("Book a meeting"));
    // Nothing has reached the host yet — this renderer reports only on flush.
    expect(approveReviewTask).not.toHaveBeenCalled();

    await waitFor(() => expect(continueButton()).not.toBeNull());
    fireEvent.click(continueButton()!);

    await waitFor(() => expect(approveReviewTask).toHaveBeenCalledTimes(1));
    const [, payload, payloadFieldName] = approveReviewTask.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      unknown,
    ];
    expect(payload.callToAction).toBe("Book a meeting");
    expect(payloadFieldName).toBe("callToAction");
  });
});

// ---------------------------------------------------------------------------
// THE MAINTAINER'S RULE OF 2026-09-23 (cinatra#3358): a required field left
// empty shows an error on Continue; an optional one does not; a mixed mask
// needs every required field.
//
// The per-field setup gate asks only for REQUIRED fields
// (`pendingFields = requiredFields.filter(...)` in execution.ts); the one
// required field an empty box still answers is one whose own schema declares a
// `default` — the server settles it with that default (cinatra#3452). The mask
// holding both kinds is the grouped setup form, which validates itself.
// ---------------------------------------------------------------------------

describe("a required field left empty shows an error on Continue; an optional one does not", () => {
  const NO_ANSWER = "Add an answer before continuing.";

  it("refuses a box typed into and cleared, and sends nothing (S1)", async () => {
    const { toast } = await import("@/lib/cinatra-toast");
    await renderSetupGate();
    fireEvent.change(field(), { target: { value: "Book" } });
    await waitFor(() => expect(field().value).toBe("Book"));
    fireEvent.change(field(), { target: { value: "" } });
    await waitFor(() => expect(field().value).toBe(""));
    await waitFor(() => expect(continueButton()).not.toBeNull());
    fireEvent.click(continueButton()!);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(NO_ANSWER));
    expect(approveReviewTask).not.toHaveBeenCalled();
    expect(field()).not.toBeNull();
  });

  it("refuses a buffering field flushed empty, and sends nothing (S2)", async () => {
    const { toast } = await import("@/lib/cinatra-toast");
    const { fieldRendererRegistry } = await import("../field-renderer-registry");
    fieldRendererRegistry.register({
      id: FLUSH_BINDING_ID,
      priority: 500,
      condition: (_f, _s, ctx) => ctx.xRenderer === FLUSH_BINDING_ID,
      renderer: FakeFlushOnlyRenderer as unknown as RegistryEntry["renderer"],
    });
    interruptContext = {
      schema: { type: "string", "x-renderer": FLUSH_BINDING_ID },
      xRenderer: FLUSH_BINDING_ID,
      values: {},
      reviewTaskId: "setup-run-3358",
      fieldName: "callToAction",
    };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);
    const flushField = () =>
      document.querySelector("[data-testid='fake-flush-field']") as HTMLTextAreaElement;
    await waitFor(() => expect(flushField()).not.toBeNull());
    await waitFor(() => expect(continueButton()).not.toBeNull());
    fireEvent.click(continueButton()!);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(NO_ANSWER));
    expect(approveReviewTask).not.toHaveBeenCalled();
    expect(flushField()).not.toBeNull();

    // The refused blank is not kept: the reader types, presses again, and the
    // field is asked for its value anew — the typed answer is sent.
    fireEvent.change(flushField(), { target: { value: "Book a meeting" } });
    await waitFor(() => expect(flushField().value).toBe("Book a meeting"));
    await waitFor(() => expect(continueButton()!.disabled).toBe(false));
    fireEvent.click(continueButton()!);
    await waitFor(() => expect(approveReviewTask).toHaveBeenCalledTimes(1));
    const [, payload] = approveReviewTask.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(payload.callToAction).toBe("Book a meeting");
  });

  it("sends a field that declares a default, left empty, with no error (S3)", async () => {
    const { toast } = await import("@/lib/cinatra-toast");
    const schema = { type: "string", default: "Book a demo", "x-renderer": FAKE_BINDING_ID };
    interruptContext = {
      schema,
      xRenderer: FAKE_BINDING_ID,
      values: {},
      reviewTaskId: "setup-run-3358",
      fieldName: "callToAction",
    };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);
    await waitFor(() => expect(field()).not.toBeNull());
    await waitFor(() => expect(continueButton()).not.toBeNull());
    fireEvent.click(continueButton()!);

    await waitFor(() => expect(approveReviewTask).toHaveBeenCalledTimes(1));
    expect(approveReviewTask).toHaveBeenCalledWith(
      "setup-run-3358",
      { callToAction: null },
      "callToAction",
      schema,
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("a mask with both kinds refuses until every required field is filled (G1)", async () => {
    const { GROUPED_SETUP_FORM_RENDERER_ID } = await import("../agent-builder-ids");
    const { GroupedSetupFormRenderer, isGroupedSetupFormField } = await import(
      "../grouped-setup-form-renderer"
    );
    const { fieldRendererRegistry } = await import("../field-renderer-registry");
    fieldRendererRegistry.register({
      id: GROUPED_SETUP_FORM_RENDERER_ID,
      priority: 50,
      condition: isGroupedSetupFormField,
      renderer: GroupedSetupFormRenderer,
      drawsOwnSubmit: true,
    });
    interruptContext = {
      schema: {
        type: "object",
        properties: {
          callToAction: { type: "string" },
          senderName: { type: "string" },
        },
        required: ["callToAction"],
      },
      xRenderer: GROUPED_SETUP_FORM_RENDERER_ID,
      values: {},
      reviewTaskId: "setup-run-3358",
    };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);
    const box = (name: string) =>
      document.querySelector(`#field-${name}`) as HTMLInputElement | null;
    const errorLineUnder = (name: string) =>
      Array.from(box(name)?.closest("div")?.querySelectorAll("p") ?? []).some(
        (p) => (p.textContent ?? "").trim() === "Required",
      );
    const saveButton = () =>
      Array.from(document.querySelectorAll("button")).find((b) =>
        /save & start run/i.test((b.textContent ?? "").trim()),
      ) as HTMLButtonElement | undefined;
    await waitFor(() => expect(box("callToAction")).not.toBeNull());
    await waitFor(() => expect(box("senderName")).not.toBeNull());
    await waitFor(() => expect(saveButton()).toBeDefined());

    // Both empty: nothing sent, the error under the required field only.
    fireEvent.click(saveButton()!);
    await waitFor(() => expect(errorLineUnder("callToAction")).toBe(true));
    expect(errorLineUnder("senderName")).toBe(false);
    expect(approveReviewTask).not.toHaveBeenCalled();

    // The required field filled, the optional one left empty: sent once.
    fireEvent.change(box("callToAction")!, { target: { value: "Book a meeting" } });
    await waitFor(() => expect(box("callToAction")!.value).toBe("Book a meeting"));
    await waitFor(() => expect(saveButton()!.disabled).toBe(false));
    fireEvent.click(saveButton()!);
    await waitFor(() => expect(approveReviewTask).toHaveBeenCalledTimes(1));
    const [taskId, payload] = approveReviewTask.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(taskId).toBe("setup-run-3358");
    expect(payload.callToAction).toBe("Book a meeting");
    expect(errorLineUnder("callToAction")).toBe(false);
    expect(errorLineUnder("senderName")).toBe(false);
  });

  it("refuses a required field whose declared default is empty, and sends nothing (D1)", async () => {
    const { toast } = await import("@/lib/cinatra-toast");
    interruptContext = {
      schema: { type: "string", default: "", "x-renderer": FAKE_BINDING_ID },
      xRenderer: FAKE_BINDING_ID,
      values: {},
      reviewTaskId: "setup-run-3358",
      fieldName: "callToAction",
    };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);
    await waitFor(() => expect(field()).not.toBeNull());
    await waitFor(() => expect(continueButton()).not.toBeNull());
    fireEvent.click(continueButton()!);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(NO_ANSWER));
    expect(approveReviewTask).not.toHaveBeenCalled();
    expect(field()).not.toBeNull();
  });

  it("refuses a required field whose declared default is whitespace only, and sends nothing (D2)", async () => {
    const { toast } = await import("@/lib/cinatra-toast");
    interruptContext = {
      schema: { type: "string", default: "   ", "x-renderer": FAKE_BINDING_ID },
      xRenderer: FAKE_BINDING_ID,
      values: {},
      reviewTaskId: "setup-run-3358",
      fieldName: "callToAction",
    };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);
    await waitFor(() => expect(field()).not.toBeNull());
    await waitFor(() => expect(continueButton()).not.toBeNull());
    fireEvent.click(continueButton()!);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(NO_ANSWER));
    expect(approveReviewTask).not.toHaveBeenCalled();
    expect(field()).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // THE ROAD THE LIVE FIELD ACTUALLY TAKES (cinatra#3358, the fourth picture
  // round). A required field the pack declares with `"default": ""` and no
  // renderer of its own reaches the host's schema-field fallback, which keeps
  // ITS OWN Continue: the host's registered floor draws it, so the host's
  // default renderers are registered here and the REAL floor is what renders.
  // ---------------------------------------------------------------------------
  const FALLBACK_FIELD = "offeringCompanyWebsite";

  function fallbackInput(): HTMLInputElement | null {
    return document.querySelector<HTMLInputElement>(`#field-${FALLBACK_FIELD}`);
  }

  /** The floor's own field: the nearest box around its input that also holds
   *  the field's own Continue. */
  function fallbackField(): HTMLElement {
    let el: HTMLElement | null = fallbackInput();
    while (el !== null && el.querySelector("button") === null) el = el.parentElement;
    return el as HTMLElement;
  }

  function ownContinue(): HTMLButtonElement | null {
    return (
      (Array.from(fallbackField().querySelectorAll("button")).find((b) =>
        /^continue/i.test((b.textContent ?? "").trim()),
      ) as HTMLButtonElement | undefined) ?? null
    );
  }

  async function renderFallbackGate(schemaExtra: Record<string, unknown> = {}) {
    const { SCHEMA_FIELD_FALLBACK_RENDERER_ID } = await import("../agent-builder-ids");
    const schema = {
      type: "string",
      default: "",
      description: "Offering company website",
      "x-renderer": SCHEMA_FIELD_FALLBACK_RENDERER_ID,
      ...schemaExtra,
    };
    interruptContext = {
      schema,
      xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
      values: {},
      reviewTaskId: "setup-run-3358",
      fieldName: FALLBACK_FIELD,
    };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);
    await waitFor(() => expect(fallbackInput()).not.toBeNull());
    await waitFor(() => expect(ownContinue()).not.toBeNull());
    return schema;
  }

  it("marks a required field whose declared default is empty as required on the fallback (F1)", async () => {
    const { ensureDefaultFieldRenderersRegistered } = await import("../register-default-renderers");
    ensureDefaultFieldRenderersRegistered();
    await renderFallbackGate();

    const label = document.querySelector(`label[for="field-${FALLBACK_FIELD}"]`);
    expect(label?.textContent).toBe("Offering company website *");
    expect(fallbackField().textContent).not.toContain("(optional)");
  });

  it("refuses an empty press on the fallback field's own Continue, and sends nothing (F2)", async () => {
    const { ensureDefaultFieldRenderersRegistered } = await import("../register-default-renderers");
    ensureDefaultFieldRenderersRegistered();
    const { toast } = await import("@/lib/cinatra-toast");
    await renderFallbackGate();
    fireEvent.click(ownContinue()!);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(NO_ANSWER));
    expect(approveReviewTask).not.toHaveBeenCalled();
    expect(fallbackInput()).not.toBeNull();
  });

  it("leaves a fallback field whose declared default is a real value optional, and sends it as before (F3)", async () => {
    const { ensureDefaultFieldRenderersRegistered } = await import("../register-default-renderers");
    ensureDefaultFieldRenderersRegistered();
    const { toast } = await import("@/lib/cinatra-toast");
    const schema = await renderFallbackGate({ default: "Book a demo" });

    expect(fallbackField().textContent).toContain("(optional)");
    fireEvent.click(ownContinue()!);

    await waitFor(() => expect(approveReviewTask).toHaveBeenCalledTimes(1));
    expect(approveReviewTask.mock.calls[0]).toEqual([
      "setup-run-3358",
      { [FALLBACK_FIELD]: "" },
      FALLBACK_FIELD,
      schema,
    ]);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("refuses an empty press on the fallback url field's own Continue, and sends nothing (F4)", async () => {
    const { ensureDefaultFieldRenderersRegistered } = await import("../register-default-renderers");
    ensureDefaultFieldRenderersRegistered();
    const { toast } = await import("@/lib/cinatra-toast");
    await renderFallbackGate({ format: "uri" });
    expect(fallbackInput()!.type).toBe("url");
    fireEvent.click(ownContinue()!);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(NO_ANSWER));
    expect(approveReviewTask).not.toHaveBeenCalled();
    expect(fallbackInput()).not.toBeNull();
  });
});
