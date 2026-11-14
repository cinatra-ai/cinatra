// @vitest-environment jsdom
/**
 * cinatra#3532 — THE RUN PAGE'S OWN SURFACE CAN PASS A PACK-DRAWN SETUP FIELD.
 *
 * The Email Outreach Agent's template is `flow`-typed, so its run page mounts
 * THIS panel (`runDetailPanelKind` answers "stepper" for orchestrator/flow
 * templates and `instance-screens.tsx` mounts `OrchestratorStepperPanel` for
 * that answer) — not the agentic panel the first leg taught. This surface's
 * setup-loop branch drew no control of its own and submitted on every
 * `onChange`, so the wizard's second field, drawn by the pack binding
 * `@cinatra-ai/email-outreach-agent:cta` (a textarea and no submit), offered the
 * reader nothing to press and could not be passed at all.
 *
 * What is pinned here:
 *   - C1: a setup gate whose resolved entry declares no submit control of its
 *     own is drawn with the product's own Continue — EXACTLY ONE control
 *     carrying `data-action="submit-hitl-screen"` in that gate's card;
 *   - C2: typing alone submits nothing (the answer is staged, keyed by the
 *     gate, and the field goes on showing what the reader typed), and the press
 *     submits exactly that value under the gate's own field name, through the
 *     same submit core the change road used;
 *   - C3: a press with the field empty submits nothing and leaves the same one
 *     gate card open, with no second card for the same field;
 *   - C4: the fallback field keeps the single Continue its own renderer draws,
 *     a mid-run gate keeps its outer Continue, and a grouped-setup form keeps
 *     its one submit.
 *
 * WHAT FIX LEG 3 ADDS (the page moved on from the answered question):
 *   - C1: once the staged answer is accepted the surface RE-READS the run and
 *     draws the run's next gate — the answered field's card is gone, the next
 *     setup field is drawn without a reload, and it opens on its own reading
 *     rather than on the previous answer;
 *   - C2: a setup step the run has been answered on and is no longer asking
 *     draws its recorded content READ-ONLY — nothing carrying
 *     `data-action="submit-hitl-screen"` and no empty box for that field;
 *   - C3: the product's Continue is disabled AND reads "Continuing…" for the
 *     whole press — the window after the send settles included, where it used
 *     to be drawn dead and still read "Continue".
 *
 * Harness mirrors orchestrator-stepper-hitl-field-label.test.tsx.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/orchestrator-stepper-panel-setup-continue-3532.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { fieldRendererRegistry } from "../field-renderer-registry";
import type { FieldRendererProps } from "../field-renderer-registry";
import { ensureOrCheckRunNameAction } from "../run-name-actions";

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

/**
 * THE CONVERSATION PANEL, PASSED THROUGH. The stepper draws it without its
 * paperclip, so no case here can attach a file from the screen; the one case
 * that needs the card's attachment road calls the `onSubmit` the card hands
 * the panel, which is the road the paperclip takes. The panel itself is the
 * real one, drawn with the same props.
 */
const conversation = vi.hoisted(() => ({
  onSubmit: null as null | ((prompt: string, attachments?: unknown[]) => Promise<void>),
}));
vi.mock("../hitl-conversation-panel", async (importOriginal) => {
  const real = await importOriginal<typeof import("../hitl-conversation-panel")>();
  const { useLayoutEffect } = await vi.importActual<typeof import("react")>("react");
  function PassThroughConversationPanel(
    props: React.ComponentProps<typeof real.HitlConversationPanel>,
  ) {
    // Handed to the test once the panel is drawn, never during its render.
    useLayoutEffect(() => {
      conversation.onSubmit = props.onSubmit as typeof conversation.onSubmit;
    });
    return <real.HitlConversationPanel {...props} />;
  }
  return { ...real, HitlConversationPanel: PassThroughConversationPanel };
});

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

/**
 * A PACK-SHAPED RENDERER THAT DRAWS NO SUBMIT CONTROL — the shape #3532 was
 * reported on. It holds what the reader typed and hands it out through
 * `onChange`, exactly as `CtaRenderer` does, and draws no button at all.
 */
const CONTROL_LESS_RENDERER_ID = "@cinatra-test/pack-agent:cta-like";
/** The same, reached on a gate the panel classifies as MID-RUN (`:output`). */
const MID_RUN_RENDERER_ID = "@cinatra-test/pack-agent:output";
/** The same, on a GROUPED-SETUP gate (`:setup-form`) — it draws its own one
 *  submit for the whole form, and the product must add nothing beside it. */
const GROUPED_SETUP_RENDERER_ID = "@cinatra-test/pack-agent:setup-form";

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
 * A PACK-SHAPED RENDERER THAT BUFFERS — it never calls `onChange` while the
 * reader types and hands its reading over only through `registerFlush`, the way
 * SchemaFieldRenderer's own text field does. The press road must ask it again
 * after a failed send, or a correction typed after the failure is never staged.
 */
const BUFFERED_RENDERER_ID = "@cinatra-test/pack-agent:buffered";

function BufferedRenderer({ fieldName, onChange, registerFlush }: FieldRendererProps) {
  const [local, setLocal] = React.useState("");
  const localRef = React.useRef(local);
  // Mirrored in an effect, not during render — the house pattern beside
  // SchemaFieldRenderer's own flushRef.
  React.useEffect(() => {
    localRef.current = local;
  }, [local]);
  React.useEffect(() => {
    if (!registerFlush) return;
    registerFlush(async () => {
      await onChange(localRef.current);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerFlush]);
  return (
    <Input
      id={`field-${fieldName}`}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
    />
  );
}

function GroupedFormRenderer({ fieldName, value, onChange }: FieldRendererProps) {
  const current = typeof value === "string" ? value : "";
  return (
    <div>
      <Input
        id={`field-${fieldName}`}
        value={current}
        onChange={(e) => void onChange(e.target.value)}
      />
      <Button type="button" data-testid="form-own-submit">
        Submit
      </Button>
    </div>
  );
}

type PanelProps = import("../orchestrator-stepper-panel").OrchestratorStepperPanelProps;

function baseProps(): PanelProps {
  return {
    runId: "run-3532",
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
    templateId: "tmpl-3532",
    templateName: "Email Outreach Agent",
  };
}

/** Mount the panel on a live single-field setup gate. */
async function mountGate(args: {
  xRenderer: string;
  fieldName: string;
  schema?: Record<string, unknown>;
  reviewTaskId?: string;
  /** Draw the panel under React.StrictMode. */
  strict?: boolean;
  /** The interrupt's values; `{ stepNumber: 0 }` makes it the run's first step. */
  values?: Record<string, unknown>;
}) {
  INTERRUPT = {
    schema: args.schema ?? { type: "string" },
    xRenderer: args.xRenderer,
    values: args.values ?? {},
    reviewTaskId: args.reviewTaskId ?? "setup-run-3532",
    fieldName: args.fieldName,
  };
  const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
  const draw = (element: React.ReactElement) =>
    args.strict === true ? <React.StrictMode>{element}</React.StrictMode> : element;
  const view = render(draw(<OrchestratorStepperPanel {...baseProps()} />));
  /** Advance the live gate under the mounted panel, as the setup loop does. */
  const advanceTo = (next: { xRenderer: string; fieldName: string; reviewTaskId?: string }) => {
    INTERRUPT = {
      schema: args.schema ?? { type: "string" },
      xRenderer: next.xRenderer,
      values: {},
      reviewTaskId: next.reviewTaskId ?? args.reviewTaskId ?? "setup-run-3532",
      fieldName: next.fieldName,
    };
    view.rerender(draw(<OrchestratorStepperPanel {...baseProps()} />));
  };
  /** The run's own status, as the stream reports it (convergence, fix leg 3). */
  const setRunStatus = (nextStatus: string) => {
    view.rerender(
      <OrchestratorStepperPanel
        {...baseProps()}
        initialStatus={nextStatus as PanelProps["initialStatus"]}
      />,
    );
  };
  return { ...view, advanceTo, setRunStatus };
}

/** Every control carrying the product's submit action, anywhere on the page. */
function productContinues(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-action="submit-hitl-screen"]'),
  );
}

function ctaBox(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>("#field-callToAction");
}

/** The run's NEXT setup field — the product's own fallback field. */
function senderNameBox(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>("#field-senderName");
}

/**
 * THE RUN'S OWN READ (cinatra#3532, fix leg 3).
 *
 * The surface re-reads the run after an accepted setup answer, through the same
 * read the run panel's own refetch takes, and this is what the run answers with.
 * Restored by `vi.unstubAllGlobals()` in `afterEach`.
 */
function stubRunRead(body: { status: string; hitlContext: unknown }) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * THE RUN AS IT MOVES (cinatra#3532 fix leg 3, convergence). A real run answers
 * its own read differently as it goes — the question it is asking now, the gap
 * between two questions, the end — and `decide` is handed the number of answers
 * the reader has sent so far, which is what the run's own movement follows.
 */
function stubMovingRunRead(
  decide: (answersSent: number) => { status: string; hitlContext: unknown },
) {
  const fetchMock = vi.fn(async () => {
    const body = decide(hitlActions.approveReviewTask.mock.calls.length);
    return { ok: true, json: async () => body };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The run's next pack-drawn question — the same renderer, its own field. */
function subjectBox(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>("#field-subject");
}

function answeredReadingFor(fieldName: string): Element | null {
  return document.querySelector(`[data-run-input-answer="${fieldName}"]`);
}

/** One gate, as the run's own read answers with it. */
function readGate(xRenderer: string, fieldName: string) {
  return {
    xRenderer,
    childRunId: null,
    reviewTaskId: "setup-run-3532",
    inputSchema: { type: "string" },
    currentValues: {},
    fieldName,
  };
}

beforeEach(() => {
  // NOTHING IN THIS FILE REACHES THE NETWORK. The surface re-reads the run after
  // an accepted setup answer (fix leg 3); the cases that care answer that read
  // with `stubRunRead`, and every other case gets a read that answers nothing.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
  );
  ensureDefaultFieldRenderersRegistered();
  // The pack-shaped entries: NO `drawsOwnSubmit`, so each declares no submit
  // control of its own — the whole point of the case.
  fieldRendererRegistry.register({
    id: CONTROL_LESS_RENDERER_ID,
    priority: 100,
    condition: (_fieldName, schema) =>
      (schema as { "x-renderer"?: unknown })["x-renderer"] === CONTROL_LESS_RENDERER_ID,
    renderer: ControlLessRenderer,
  });
  fieldRendererRegistry.register({
    id: MID_RUN_RENDERER_ID,
    priority: 100,
    condition: (_fieldName, schema) =>
      (schema as { "x-renderer"?: unknown })["x-renderer"] === MID_RUN_RENDERER_ID,
    renderer: ControlLessRenderer,
  });
  fieldRendererRegistry.register({
    id: BUFFERED_RENDERER_ID,
    priority: 100,
    condition: (_fieldName, schema) =>
      (schema as { "x-renderer"?: unknown })["x-renderer"] === BUFFERED_RENDERER_ID,
    renderer: BufferedRenderer,
  });
  fieldRendererRegistry.register({
    id: GROUPED_SETUP_RENDERER_ID,
    priority: 100,
    condition: (_fieldName, schema) =>
      (schema as { "x-renderer"?: unknown })["x-renderer"] === GROUPED_SETUP_RENDERER_ID,
    renderer: GroupedFormRenderer,
  });
});

afterEach(() => {
  cleanup();
  // RESTORE THE GLOBAL this file stubbed: the package's full run must find its
  // own `fetch` after every case here.
  vi.unstubAllGlobals();
  INTERRUPT = null;
  vi.clearAllMocks();
  // Two cases queue one-shot outcomes on this mock; put the default back.
  hitlActions.approveReviewTask.mockReset();
  hitlActions.approveReviewTask.mockResolvedValue({ ok: true as const });
  // RESTORE THE REGISTRY this file wrote into: the stub entries must not
  // outlive the file for the rest of the package's run.
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
});

describe("OrchestratorStepperPanel — a setup field whose renderer draws no control (cinatra#3532)", () => {
  it("draws exactly one product Continue beneath the pack-drawn field (C1)", async () => {
    await mountGate({ xRenderer: CONTROL_LESS_RENDERER_ID, fieldName: "callToAction" });

    await waitFor(() => expect(ctaBox()).not.toBeNull());
    await waitFor(() => expect(productContinues()).toHaveLength(1));
    expect(productContinues()[0]!.textContent).toMatch(/Continue/);
  });

  it("typing alone submits nothing, and the press passes the value the renderer holds (C2)", async () => {
    await mountGate({ xRenderer: CONTROL_LESS_RENDERER_ID, fieldName: "callToAction" });

    await waitFor(() => expect(ctaBox()).not.toBeNull());
    // A field renderer is CONTROLLED by its `value` prop, so typing is one
    // change per character: a staging path that fed nothing back would clear
    // the box after each one and pass a single character to the server.
    for (const text of ["B", "Bo", "Book a meeting"]) {
      fireEvent.change(ctaBox()!, { target: { value: text } });
      await waitFor(() => expect(ctaBox()!.value).toBe(text));
    }

    // The wizard no longer submits on every change — the reader decides when.
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();

    await waitFor(() => expect(productContinues()).toHaveLength(1));
    fireEvent.click(productContinues()[0]!);

    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    expect(hitlActions.approveReviewTask).toHaveBeenLastCalledWith(
      "setup-run-3532",
      { callToAction: "Book a meeting" },
      "callToAction",
      { type: "string" },
    );
  });

  it("a press with the field empty sends nothing and leaves the one gate card open (C3)", async () => {
    await mountGate({ xRenderer: CONTROL_LESS_RENDERER_ID, fieldName: "callToAction" });

    await waitFor(() => expect(ctaBox()).not.toBeNull());
    await waitFor(() => expect(productContinues()).toHaveLength(1));
    fireEvent.click(productContinues()[0]!);

    await waitFor(() => expect(productContinues()).toHaveLength(1));
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    // The same gate, still open with its own reading — no second card for the
    // same field, and no card saying the review is no longer open.
    expect(document.querySelectorAll("#field-callToAction")).toHaveLength(1);
    expect(document.body.textContent ?? "").not.toMatch(/no longer open/i);
  });

  it("leaves the fallback field alone — no second Continue beside its own (C4)", async () => {
    await mountGate({
      xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
      fieldName: "offeringCompanyWebsite",
    });

    await waitFor(() =>
      expect(document.querySelector("#field-offeringCompanyWebsite")).not.toBeNull(),
    );
    expect(productContinues()).toHaveLength(0);
  });

  it("a mid-run gate keeps its outer Continue and gains nothing beside it (C4)", async () => {
    await mountGate({ xRenderer: MID_RUN_RENDERER_ID, fieldName: "callToAction" });

    await waitFor(() => expect(ctaBox()).not.toBeNull());
    expect(productContinues()).toHaveLength(0);
    const outer = Array.from(document.querySelectorAll("button")).filter((b) =>
      /Continue/.test(b.textContent ?? ""),
    );
    expect(outer).toHaveLength(1);
  });

  // --- convergence round (codex, read-only) -------------------------------
  it("sends the gate's answer exactly once — a second press after it lands submits nothing (C3)", async () => {
    await mountGate({ xRenderer: CONTROL_LESS_RENDERER_ID, fieldName: "callToAction" });

    await waitFor(() => expect(ctaBox()).not.toBeNull());
    fireEvent.change(ctaBox()!, { target: { value: "Book a meeting" } });
    await waitFor(() => expect(ctaBox()!.value).toBe("Book a meeting"));

    fireEvent.click(productContinues()[0]!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));

    // The card is still drawn until the stream advances it — and its control is
    // spent: the same approval is never sent twice.
    await waitFor(() => expect(productContinues()[0]!.disabled).toBe(true));
    fireEvent.click(productContinues()[0]!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
  });

  it("asks a buffering renderer again after a failed send, so the retry passes the correction (C2)", async () => {
    hitlActions.approveReviewTask
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ ok: true as const });
    await mountGate({ xRenderer: BUFFERED_RENDERER_ID, fieldName: "callToAction" });

    await waitFor(() => expect(ctaBox()).not.toBeNull());
    // This renderer hands nothing over while the reader types.
    fireEvent.change(ctaBox()!, { target: { value: "Book a meting" } });
    await waitFor(() => expect(productContinues()).toHaveLength(1));
    fireEvent.click(productContinues()[0]!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    expect(hitlActions.approveReviewTask).toHaveBeenLastCalledWith(
      "setup-run-3532",
      { callToAction: "Book a meting" },
      "callToAction",
      { type: "string" },
    );

    // The send failed; the reader fixes the typo and presses again.
    await waitFor(() => expect(productContinues()[0]!.disabled).toBe(false));
    fireEvent.change(ctaBox()!, { target: { value: "Book a meeting" } });
    fireEvent.click(productContinues()[0]!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(2));
    expect(hitlActions.approveReviewTask).toHaveBeenLastCalledWith(
      "setup-run-3532",
      { callToAction: "Book a meeting" },
      "callToAction",
      { type: "string" },
    );
  });

  it("never sends one field's staged answer for the next question (C2)", async () => {
    const gate = await mountGate({
      xRenderer: CONTROL_LESS_RENDERER_ID,
      fieldName: "callToAction",
    });

    await waitFor(() => expect(ctaBox()).not.toBeNull());
    fireEvent.change(ctaBox()!, { target: { value: "Book a meeting" } });
    await waitFor(() => expect(ctaBox()!.value).toBe("Book a meeting"));

    // The setup loop advances to the next field on the same renderer, with no
    // frame in between — the card never unmounts.
    gate.advanceTo({ xRenderer: CONTROL_LESS_RENDERER_ID, fieldName: "subjectLine" });
    await waitFor(() =>
      expect(document.querySelector<HTMLInputElement>("#field-subjectLine")).not.toBeNull(),
    );
    // The next question starts empty, and a press before it is answered sends
    // nothing at all — least of all the previous field's answer.
    expect(document.querySelector<HTMLInputElement>("#field-subjectLine")!.value).toBe("");
    await waitFor(() => expect(productContinues()).toHaveLength(1));
    fireEvent.click(productContinues()[0]!);
    await waitFor(() => expect(productContinues()).toHaveLength(1));
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });

  it("a grouped-setup form keeps its one submit (C4)", async () => {
    await mountGate({ xRenderer: GROUPED_SETUP_RENDERER_ID, fieldName: "callToAction" });

    await waitFor(() => expect(ctaBox()).not.toBeNull());
    expect(productContinues()).toHaveLength(0);
    expect(document.querySelectorAll('[data-testid="form-own-submit"]')).toHaveLength(1);
  });

  // --- fix leg 3: the page moves on from the question it answered -----------
  it("draws the run's NEXT gate once the staged answer is accepted (C1)", async () => {
    // The run's own read answers with the question it is asking NOW — its third
    // setup gate, drawn by the product's own fallback field — while the stream
    // goes on handing the panel the gate that was just answered.
    stubRunRead({
      status: "pending_approval",
      hitlContext: readGate(SCHEMA_FIELD_FALLBACK_RENDERER_ID, "senderName"),
    });
    await mountGate({ xRenderer: CONTROL_LESS_RENDERER_ID, fieldName: "callToAction" });

    await waitFor(() => expect(ctaBox()).not.toBeNull());
    fireEvent.change(ctaBox()!, { target: { value: "Book a meeting" } });
    await waitFor(() => expect(ctaBox()!.value).toBe("Book a meeting"));
    await waitFor(() => expect(productContinues()).toHaveLength(1));
    fireEvent.click(productContinues()[0]!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));

    // The page moves on without a reload: the answered field's card is gone and
    // the run's next setup field is drawn in its place.
    await waitFor(() => expect(senderNameBox()).not.toBeNull());
    expect(document.querySelectorAll("#field-callToAction")).toHaveLength(0);
    // …and the new question opens on its own reading, never on the answer the
    // reader gave the previous one.
    expect(senderNameBox()!.value).toBe("");
  });

  it("draws an answered, closed setup step read-only with no Continue (C2)", async () => {
    // THE RUN HAS MOVED PAST THE QUESTION: its own read answers that it is
    // asking nothing at all, while the stream goes on handing the panel the
    // gate that was just answered — the half-hour reading the second picture
    // round photographed, where the answered field came back as an empty
    // question with a live Continue.
    stubRunRead({ status: "queued", hitlContext: null });
    await mountGate({ xRenderer: CONTROL_LESS_RENDERER_ID, fieldName: "callToAction" });

    await waitFor(() => expect(ctaBox()).not.toBeNull());
    fireEvent.change(ctaBox()!, { target: { value: "Book a meeting" } });
    await waitFor(() => expect(ctaBox()!.value).toBe("Book a meeting"));
    await waitFor(() => expect(productContinues()).toHaveLength(1));
    fireEvent.click(productContinues()[0]!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));

    // THE STEP READS BACK: what the reader answered is legible under the label
    // it was asked under…
    await waitFor(() =>
      expect(
        document.querySelector('[data-run-input-step-reading="answered"]'),
      ).not.toBeNull(),
    );
    expect(
      document.querySelector('[data-run-input-answer="callToAction"]')?.textContent,
    ).toContain("Book a meeting");
    // …and there is nothing to press and no empty box asking it a second time.
    expect(productContinues()).toHaveLength(0);
    expect(document.querySelectorAll("#field-callToAction")).toHaveLength(0);
  });

  it("is disabled and reads Continuing… for the whole press (C3)", async () => {
    // The run is still asking the same question when the surface re-reads it, so
    // the answered card stays drawn and its control can be read after the send.
    stubRunRead({
      status: "pending_approval",
      hitlContext: readGate(CONTROL_LESS_RENDERER_ID, "callToAction"),
    });
    let settleSend: ((outcome: { ok: true }) => void) | undefined;
    hitlActions.approveReviewTask.mockImplementationOnce(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          settleSend = resolve;
        }),
    );
    await mountGate({ xRenderer: CONTROL_LESS_RENDERER_ID, fieldName: "callToAction" });

    await waitFor(() => expect(ctaBox()).not.toBeNull());
    fireEvent.change(ctaBox()!, { target: { value: "Book a meeting" } });
    await waitFor(() => expect(ctaBox()!.value).toBe("Book a meeting"));
    fireEvent.click(productContinues()[0]!);

    // IN FLIGHT: the control is dead and says what it is doing.
    await waitFor(() => expect(productContinues()[0]!.disabled).toBe(true));
    expect(productContinues()[0]!.textContent).toContain("Continuing…");

    // SETTLED: the send has landed and the gate is spent. The control is still
    // dead — and it never falls back to reading "Continue" while it cannot be
    // pressed.
    await waitFor(() => expect(settleSend).toBeDefined());
    await act(async () => {
      settleSend!({ ok: true });
    });
    expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1);
    expect(productContinues()[0]!.disabled).toBe(true);
    expect(productContinues()[0]!.textContent).toContain("Continuing…");
  });

  // --- convergence: the road holds for a WHOLE setup loop, not one press ----
  it("advances again on the SECOND answer and never falls back to the question before it (C1)", async () => {
    // THE STREAM IS STUCK on the first question for the whole case — the very
    // reading this fix exists for. The run answers with its second question
    // until that one is answered too, and then with the gap after it.
    stubMovingRunRead((answersSent) =>
      answersSent < 2
        ? {
            status: "pending_approval",
            hitlContext: readGate(CONTROL_LESS_RENDERER_ID, "subject"),
          }
        : { status: "queued", hitlContext: null },
    );
    await mountGate({ xRenderer: CONTROL_LESS_RENDERER_ID, fieldName: "callToAction" });

    await waitFor(() => expect(ctaBox()).not.toBeNull());
    fireEvent.change(ctaBox()!, { target: { value: "Book a meeting" } });
    await waitFor(() => expect(ctaBox()!.value).toBe("Book a meeting"));
    fireEvent.click(productContinues()[0]!);

    // The page moved on to the second question.
    await waitFor(() => expect(subjectBox()).not.toBeNull());
    fireEvent.change(subjectBox()!, { target: { value: "A quick hello" } });
    await waitFor(() => expect(subjectBox()!.value).toBe("A quick hello"));
    await waitFor(() => expect(productContinues()).toHaveLength(1));
    fireEvent.click(productContinues()[0]!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(2));

    // AND IT MOVES ON AGAIN. The question before last is NOT what the page
    // comes back to — the second answer reads back, and the first field's box
    // is nowhere on the page.
    await waitFor(() =>
      expect(answeredReadingFor("subject")?.textContent).toContain("A quick hello"),
    );
    expect(document.querySelectorAll("#field-callToAction")).toHaveLength(0);
    expect(productContinues()).toHaveLength(0);
  });

  it("keeps asking the run while it sits BETWEEN two questions (C1)", async () => {
    // The run is read in the gap first — queued, asking nothing, exactly the
    // status the answered run was photographed in — and opens its next question
    // only afterwards. The gap is not the end of the road.
    let reads = 0;
    stubMovingRunRead(() => {
      reads += 1;
      return reads === 1
        ? { status: "queued", hitlContext: null }
        : {
            status: "pending_approval",
            hitlContext: readGate(CONTROL_LESS_RENDERER_ID, "subject"),
          };
    });
    await mountGate({ xRenderer: CONTROL_LESS_RENDERER_ID, fieldName: "callToAction" });

    await waitFor(() => expect(ctaBox()).not.toBeNull());
    fireEvent.change(ctaBox()!, { target: { value: "Book a meeting" } });
    await waitFor(() => expect(ctaBox()!.value).toBe("Book a meeting"));
    fireEvent.click(productContinues()[0]!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));

    // The question the run opened after the gap is drawn, without a reload.
    await waitFor(() => expect(subjectBox()).not.toBeNull());
    expect(document.querySelectorAll("#field-callToAction")).toHaveLength(0);
  });

  it("never draws the answered step in front of a finished run (C2)", async () => {
    stubRunRead({ status: "queued", hitlContext: null });
    const view = await mountGate({
      xRenderer: CONTROL_LESS_RENDERER_ID,
      fieldName: "callToAction",
    });

    await waitFor(() => expect(ctaBox()).not.toBeNull());
    fireEvent.change(ctaBox()!, { target: { value: "Book a meeting" } });
    await waitFor(() => expect(ctaBox()!.value).toBe("Book a meeting"));
    fireEvent.click(productContinues()[0]!);
    await waitFor(() => expect(answeredReadingFor("callToAction")).not.toBeNull());

    // THE RUN FINISHES. What belongs to a finished run is the finished run's own
    // reading — the answered step never stands in front of it.
    INTERRUPT = null;
    view.setRunStatus("completed");
    await waitFor(() =>
      expect(document.querySelector('[data-run-input-step-reading="answered"]')).toBeNull(),
    );
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
/** The same, on a gate this panel classifies as mid-run (`:list-picker`). */
const MID_RUN_TICKING_RENDERER_ID = "@cinatra-test/pack-agent:list-picker";
/** The email outreach agent's own account-scope binding: a mid-run list step. */
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
 * A step that hands the test its report and its value, so that a report and a
 * press can run inside one act(): the press then reaches a Continue that is
 * still drawn available, and only the press-time check can stop it.
 */
const stepHandle: { report: (valid: boolean) => void; stage: (ids: string[]) => void } = {
  report: () => {},
  stage: () => {},
};
function HandleRenderer({ schema, onChange, onValidityChange }: FieldRendererProps) {
  React.useEffect(() => {
    stepHandle.report = (valid) => onValidityChange?.(valid);
    stepHandle.stage = (ids) => {
      const picks = { type: "list", listIds: ids, listNames: ids.map((t) => `View ${t}`) };
      void onChange(schema.type === "string" ? JSON.stringify(picks) : picks);
    };
  });
  return <p>Handle step</p>;
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

describe("OrchestratorStepperPanel — a renderer that reports its value unsendable (cinatra#3562)", () => {
  beforeEach(() => {
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
    const view = await mountGate({ xRenderer: TICKING_RENDERER_ID, fieldName: "accountScope" });

    await view.findByRole("checkbox", { name: "View one" });
    await waitFor(() => expect(productContinues()[0]!.disabled).toBe(true));
    fireEvent.click(productContinues()[0]!);
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("checkbox", { name: "View two" }));
    await waitFor(() => expect(productContinues()[0]!.disabled).toBe(false));
    fireEvent.click(view.getByRole("checkbox", { name: "View two" }));
    await waitFor(() => expect(productContinues()[0]!.disabled).toBe(true));

    fireEvent.click(view.getByRole("checkbox", { name: "View two" }));
    fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
    await waitFor(() => expect(productContinues()[0]!.disabled).toBe(false));
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    fireEvent.click(productContinues()[0]!);
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
        { type: "string" },
      ),
    );
  });

  it("holds a mid-run gate's Continue while nothing is ticked and resumes with every tick", async () => {
    const view = await mountGate({
      xRenderer: MID_RUN_TICKING_RENDERER_ID,
      fieldName: "accountScope",
      schema: { type: "object" },
      reviewTaskId: "review-run-3562",
    });

    await view.findByRole("checkbox", { name: "View one" });
    expect(productContinues()).toHaveLength(0);
    const outer = () => view.getByRole("button", { name: /Continue/ }) as HTMLButtonElement;
    await waitFor(() => expect(outer().disabled).toBe(true));
    fireEvent.click(outer());
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("checkbox", { name: "View two" }));
    fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
    await waitFor(() => expect(outer().disabled).toBe(false));
    fireEvent.click(outer());
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const [taskId, payload] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(taskId).toBe("review-run-3562");
    expect(JSON.parse(payload.approvalNote as string)).toMatchObject({
      type: "list",
      listIds: ["two", "one"],
      listNames: ["View two", "View one"],
    });
  });

  it("holds the email outreach agent's own mid-run list step and resumes it with every tick", async () => {
    // THE REAL GATE: the outreach agent's account-scope step is a mid-run
    // `:list-picker` gate under this binding id. The build declares the id
    // (the host's list kind draws it today); the stand-in below takes its place
    // the way an extension-shipped component does, which keeps its own send
    // (`drawsOwnSubmit: true`, the map-first branch of the default renderers).
    expect(fieldRendererRegistry.list().some((e) => e.id === OUTREACH_LIST_PICKER_ID)).toBe(true);
    fieldRendererRegistry.register({
      id: OUTREACH_LIST_PICKER_ID,
      priority: 90,
      condition: (_fieldName, schema) =>
        (schema as { "x-renderer"?: unknown })["x-renderer"] === OUTREACH_LIST_PICKER_ID,
      renderer: TickingRenderer,
      drawsOwnSubmit: true,
    });
    const view = await mountGate({
      xRenderer: OUTREACH_LIST_PICKER_ID,
      fieldName: "accountScope",
      schema: { type: "object" },
      reviewTaskId: "review-run-3562-outreach",
    });

    await view.findByRole("checkbox", { name: "View one" });
    expect(productContinues()).toHaveLength(0);
    const outer = () => view.getByRole("button", { name: /Continue/ }) as HTMLButtonElement;
    await waitFor(() => expect(outer().disabled).toBe(true));
    fireEvent.click(outer());
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
    await waitFor(() => expect(outer().disabled).toBe(false));
    fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
    await waitFor(() => expect(outer().disabled).toBe(true));
    fireEvent.click(outer());
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
    fireEvent.click(view.getByRole("checkbox", { name: "View two" }));
    await waitFor(() => expect(outer().disabled).toBe(false));
    fireEvent.click(outer());
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const [taskId, payload] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(taskId).toBe("review-run-3562-outreach");
    const note = JSON.parse(payload.approvalNote as string) as Record<string, unknown>;
    expect(note).toMatchObject({
      type: "list",
      listIds: ["one", "two"],
      listNames: ["View one", "View two"],
    });
    expect(typeof note.snapshotAt).toBe("string");
    expect(note).not.toHaveProperty("listId");
  });

  it("a report belongs to its own gate: the next gate, whose renderer reports nothing, is not held", async () => {
    const view = await mountGate({ xRenderer: TICKING_RENDERER_ID, fieldName: "accountScope" });

    await view.findByRole("checkbox", { name: "View one" });
    await waitFor(() => expect(productContinues()[0]!.disabled).toBe(true));
    view.advanceTo({ xRenderer: CONTROL_LESS_RENDERER_ID, fieldName: "callToAction" });
    await waitFor(() => expect(ctaBox()).not.toBeNull());
    await waitFor(() => expect(productContinues()).toHaveLength(1));
    expect(productContinues()[0]!.disabled).toBe(false);
  });

  it("a report leaves with its renderer: one that takes its place on the same gate and reports nothing is not held", async () => {
    const view = await mountGate({ xRenderer: TICKING_RENDERER_ID, fieldName: "accountScope" });

    await view.findByRole("checkbox", { name: "View one" });
    await waitFor(() => expect(productContinues()[0]!.disabled).toBe(true));
    replaceTickingRenderer(TICKING_RENDERER_ID, QuietTickedRenderer);
    view.advanceTo({ xRenderer: TICKING_RENDERER_ID, fieldName: "accountScope" });

    await waitFor(() =>
      expect((view.getByRole("checkbox", { name: "View one" }) as HTMLInputElement).checked).toBe(true),
    );
    await waitFor(() => expect(productContinues()[0]!.disabled).toBe(false));
  });

  it("a gate drawn again, ticked, by a renderer that reports nothing is not held by the report made before", async () => {
    const view = await mountGate({ xRenderer: TICKING_RENDERER_ID, fieldName: "accountScope" });

    await view.findByRole("checkbox", { name: "View one" });
    await waitFor(() => expect(productContinues()[0]!.disabled).toBe(true));
    view.advanceTo({ xRenderer: CONTROL_LESS_RENDERER_ID, fieldName: "callToAction" });
    await waitFor(() => expect(ctaBox()).not.toBeNull());
    replaceTickingRenderer(TICKING_RENDERER_ID, QuietTickedRenderer);
    view.advanceTo({ xRenderer: TICKING_RENDERER_ID, fieldName: "accountScope" });

    await waitFor(() =>
      expect((view.getByRole("checkbox", { name: "View one" }) as HTMLInputElement).checked).toBe(true),
    );
    await waitFor(() => expect(productContinues()[0]!.disabled).toBe(false));
  });

  it("a generic confirmation draws no renderer, so its Continue is never held", async () => {
    const view = await mountGate({
      xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
      fieldName: "accountScope",
      schema: { type: "object" },
      reviewTaskId: "review-run-3562-confirm",
    });

    const outer = await view.findByRole("button", { name: /Continue/ });
    expect((outer as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(outer);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const [taskId, payload] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(taskId).toBe("review-run-3562-confirm");
    expect(payload).toMatchObject({ approved: true });
  });

  it("a setup field's Continue pressed in the same turn as a false report sends nothing", async () => {
    replaceTickingRenderer(TICKING_RENDERER_ID, HandleRenderer);
    const view = await mountGate({ xRenderer: TICKING_RENDERER_ID, fieldName: "accountScope" });

    await view.findByText("Handle step");
    act(() => stepHandle.stage(["one"]));
    await waitFor(() => expect(productContinues()[0]?.disabled).toBe(false));
    act(() => {
      stepHandle.report(false);
      fireEvent.click(productContinues()[0]!);
    });
    await waitFor(() => expect(productContinues()[0]?.disabled).toBe(true));
    act(() => {
      stepHandle.stage(["two"]);
      stepHandle.report(true);
    });
    await waitFor(() => expect(productContinues()[0]?.disabled).toBe(false));
    fireEvent.click(productContinues()[0]!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalled());
    expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1);
    expect(hitlActions.approveReviewTask).toHaveBeenNthCalledWith(
      1,
      "setup-run-3532",
      { accountScope: JSON.stringify({ type: "list", listIds: ["two"], listNames: ["View two"] }) },
      "accountScope",
      { type: "string" },
    );
  });

  it("a mid-run gate's Continue pressed in the same turn as a false report sends nothing", async () => {
    replaceTickingRenderer(MID_RUN_TICKING_RENDERER_ID, HandleRenderer);
    const view = await mountGate({
      xRenderer: MID_RUN_TICKING_RENDERER_ID,
      fieldName: "accountScope",
      schema: { type: "object" },
      reviewTaskId: "review-run-3562",
    });
    const outer = () => view.queryByRole("button", { name: /Continue/ }) as HTMLButtonElement | null;

    await view.findByText("Handle step");
    act(() => stepHandle.stage(["one"]));
    await waitFor(() => expect(outer()?.disabled).toBe(false));
    act(() => {
      stepHandle.report(false);
      fireEvent.click(outer()!);
    });
    await waitFor(() => expect(outer()?.disabled).toBe(true));
    act(() => {
      stepHandle.stage(["two"]);
      stepHandle.report(true);
    });
    await waitFor(() => expect(outer()?.disabled).toBe(false));
    fireEvent.click(outer()!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalled());
    expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1);
    const [taskId, payload] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(taskId).toBe("review-run-3562");
    expect(JSON.parse(payload.approvalNote as string)).toMatchObject({
      type: "list",
      listIds: ["two"],
      listNames: ["View two"],
    });
  });

  it("a renderer that takes the gate's place and reports false from a layout effect keeps it held", async () => {
    const view = await mountGate({ xRenderer: TICKING_RENDERER_ID, fieldName: "accountScope" });

    await view.findByRole("checkbox", { name: "View one" });
    fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
    await waitFor(() => expect(productContinues()[0]!.disabled).toBe(false));
    replaceTickingRenderer(TICKING_RENDERER_ID, LayoutHeldRenderer);
    view.advanceTo({ xRenderer: TICKING_RENDERER_ID, fieldName: "accountScope" });

    await view.findByText("Layout step");
    await waitFor(() => expect(productContinues()[0]!.disabled).toBe(true));
    fireEvent.click(productContinues()[0]!);
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });

  it("a gate of another review task with the same renderer and field gets a new renderer, which holds it", async () => {
    keptStep.mounts = 0;
    replaceTickingRenderer(TICKING_RENDERER_ID, KeptStateRenderer);
    const view = await mountGate({ xRenderer: TICKING_RENDERER_ID, fieldName: "accountScope" });

    await view.findByRole("checkbox", { name: "View one" });
    await waitFor(() => expect(productContinues()[0]!.disabled).toBe(true));
    view.advanceTo({
      xRenderer: TICKING_RENDERER_ID,
      fieldName: "accountScope",
      reviewTaskId: "setup-run-3532-next",
    });

    await waitFor(() => expect(keptStep.mounts).toBe(2));
    await waitFor(() => expect(productContinues()[0]!.disabled).toBe(true));
    fireEvent.click(productContinues()[0]!);
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
    await waitFor(() => expect(productContinues()[0]!.disabled).toBe(false));
  });

  it("under StrictMode a renderer's report holds its gate exactly while it is false, and leaves with it", async () => {
    const view = await mountGate({ xRenderer: TICKING_RENDERER_ID, fieldName: "accountScope", strict: true });

    await view.findByRole("checkbox", { name: "View one" });
    await waitFor(() => expect(productContinues()[0]!.disabled).toBe(true));
    fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
    await waitFor(() => expect(productContinues()[0]!.disabled).toBe(false));
    fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
    await waitFor(() => expect(productContinues()[0]!.disabled).toBe(true));
    fireEvent.click(productContinues()[0]!);
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();

    replaceTickingRenderer(TICKING_RENDERER_ID, QuietTickedRenderer);
    view.advanceTo({ xRenderer: TICKING_RENDERER_ID, fieldName: "accountScope" });
    await waitFor(() =>
      expect((view.getByRole("checkbox", { name: "View one" }) as HTMLInputElement).checked).toBe(true),
    );
    await waitFor(() => expect(productContinues()[0]!.disabled).toBe(false));
  });

  // --- the stepper's gate card is NOT keyed by the review task ---------------
  // Only the renderer below it is. The card's own per-gate state therefore
  // outlives a change of review task, and the card clears it itself when the
  // task changes. These two cases pin that clearing.
  const BLOCKED = '[data-conformance-id="review-gate-blocked"]';
  const outerContinue = () =>
    Array.from(document.querySelectorAll("button")).find((b) =>
      /Continue/.test(b.textContent ?? ""),
    ) ?? null;

  it("the card's blocked state goes with its review task: the next task's gate is open", async () => {
    hitlActions.approveReviewTask.mockResolvedValueOnce({
      ok: false,
      blocked: "no-longer-pending",
    } as never);
    const view = await mountGate({
      xRenderer: MID_RUN_RENDERER_ID,
      fieldName: "callToAction",
      reviewTaskId: "review-run-3562-a",
    });

    await waitFor(() => expect(outerContinue()).not.toBeNull());
    fireEvent.click(outerContinue()!);
    await waitFor(() => expect(document.querySelector(BLOCKED)).not.toBeNull());

    view.advanceTo({
      xRenderer: MID_RUN_RENDERER_ID,
      fieldName: "callToAction",
      reviewTaskId: "review-run-3562-b",
    });
    await waitFor(() => expect(document.querySelector(BLOCKED)).toBeNull());
    await waitFor(() => expect(outerContinue()).not.toBeNull());
    fireEvent.click(outerContinue()!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(2));
    const [nextTaskId] = hitlActions.approveReviewTask.mock.calls[1] as unknown as [string];
    expect(nextTaskId).toBe("review-run-3562-b");
  });

  it("the card's pending attachments go with their review task: the next task's Continue sends none", async () => {
    const ATTACHMENT = {
      artifactId: "art-3562-attached",
      representationRevisionId: "rep-3562",
      digest: "sha256:3562",
      mime: "application/pdf",
      originKind: "upload",
      filename: "brief.pdf",
      title: "brief.pdf",
      size: 3,
    };
    conversation.onSubmit = null;
    hitlActions.approveReviewTask.mockResolvedValueOnce({
      ok: false,
      blocked: "no-longer-pending",
    } as never);
    const view = await mountGate({
      xRenderer: MID_RUN_RENDERER_ID,
      fieldName: "callToAction",
      reviewTaskId: "review-run-3562-attach-a",
    });

    await waitFor(() => expect(outerContinue()).not.toBeNull());
    await waitFor(() => expect(conversation.onSubmit).not.toBeNull());
    // An empty message: the card keeps the file, and the run window sends
    // nothing for an empty message, so no turn leaves this file.
    await act(async () => {
      await conversation.onSubmit!("", [ATTACHMENT]);
    });

    // The road is live: the press on the task the file was attached on carries it.
    fireEvent.click(outerContinue()!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const [, firstPayload] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(JSON.stringify(firstPayload)).toContain("art-3562-attached");
    await waitFor(() => expect(document.querySelector(BLOCKED)).not.toBeNull());

    view.advanceTo({
      xRenderer: MID_RUN_RENDERER_ID,
      fieldName: "callToAction",
      reviewTaskId: "review-run-3562-attach-b",
    });
    await waitFor(() => expect(outerContinue()).not.toBeNull());
    fireEvent.click(outerContinue()!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(2));
    const [taskId, payload] = hitlActions.approveReviewTask.mock.calls[1] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(taskId).toBe("review-run-3562-attach-b");
    expect(JSON.stringify(payload)).not.toContain("art-3562-attached");
  });
});

// ---------------------------------------------------------------------------
// cinatra#3562, fold 2 — EVERY SEND OF A HELD GATE SENDS NOTHING: a
// renderer's own submit, a grouped form's submit, and a report made while the
// press awaited the renderer's flush or the run-name check.
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

/** The run-name check, held open until the case lets it answer. */
function holdRunNameCheck(): () => Promise<void> {
  type RunNameAnswer = Awaited<ReturnType<typeof ensureOrCheckRunNameAction>>;
  let answer: (value: RunNameAnswer) => void = () => {};
  vi.mocked(ensureOrCheckRunNameAction).mockImplementationOnce(
    () =>
      new Promise<RunNameAnswer>((resolve) => {
        answer = resolve;
      }),
  );
  return async () => {
    await act(async () => {
      answer({ ok: true, name: "Run 1", nameChanged: false });
    });
  };
}

describe("OrchestratorStepperPanel — every send of a held gate sends nothing (cinatra#3562)", () => {
  const OWN_SUBMIT_ID = "@cinatra-test/pack-agent:own-submit";
  const GROUPED_TICKING_ID = "@cinatra-test/pack-agent-ticking:setup-form";

  beforeEach(() => {
    fieldRendererRegistry.register({
      id: OWN_SUBMIT_ID,
      priority: 100,
      condition: (_fieldName, schema) =>
        (schema as { "x-renderer"?: unknown })["x-renderer"] === OWN_SUBMIT_ID,
      renderer: OwnSubmitRenderer,
      drawsOwnSubmit: true,
    });
    fieldRendererRegistry.register({
      id: GROUPED_TICKING_ID,
      priority: 100,
      condition: (_fieldName, schema) =>
        (schema as { "x-renderer"?: unknown })["x-renderer"] === GROUPED_TICKING_ID,
      renderer: OwnSubmitRenderer,
    });
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

  it("a renderer's own submit sends nothing while it reports its value unsendable", async () => {
    const view = await mountGate({ xRenderer: OWN_SUBMIT_ID, fieldName: "accountScope" });

    const send = await view.findByRole("button", { name: "Send picks" });
    // The renderer keeps its own send: the product draws no Continue beside it.
    expect(productContinues()).toHaveLength(0);
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
      { type: "string" },
    );
  });

  it("a grouped form's own submit sends nothing while it reports its value unsendable", async () => {
    const view = await mountGate({
      xRenderer: GROUPED_TICKING_ID,
      fieldName: "accountScope",
      schema: { type: "object" },
    });

    const send = await view.findByRole("button", { name: "Send picks" });
    fireEvent.click(send);
    await act(async () => {});
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
    await act(async () => {});
    fireEvent.click(view.getByRole("button", { name: "Send picks" }));
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const [taskId, payload] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(taskId).toBe("setup-run-3532");
    expect(payload).toMatchObject({ listIds: ["one"], approved: true });
  });

  it("a grouped form's submit sends nothing when its report turns false while the run-name check is pending", async () => {
    const view = await mountGate({
      xRenderer: GROUPED_TICKING_ID,
      fieldName: "accountScope",
      schema: { type: "object" },
      values: { stepNumber: 0 },
    });

    await view.findByRole("button", { name: "Send picks" });
    // Held at the press: nothing is sent, and the run-name check (which can
    // name the run) is not even asked.
    fireEvent.click(view.getByRole("button", { name: "Send picks" }));
    await act(async () => {});
    expect(ensureOrCheckRunNameAction).not.toHaveBeenCalled();
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
    await act(async () => {});
    const answerRunName = holdRunNameCheck();
    fireEvent.click(view.getByRole("button", { name: "Send picks" }));
    await waitFor(() => expect(ensureOrCheckRunNameAction).toHaveBeenCalled());
    // Taken back while the check is pending: the report is now false.
    fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
    await act(async () => {});
    await answerRunName();
    await act(async () => {});
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });

  it("a mid-run gate's Continue sends nothing when its report turns false while the run-name check is pending", async () => {
    const view = await mountGate({
      xRenderer: MID_RUN_TICKING_RENDERER_ID,
      fieldName: "accountScope",
      schema: { type: "object" },
      reviewTaskId: "review-run-3562",
      values: { stepNumber: 0 },
    });
    const outer = () => view.getByRole("button", { name: /Continue/ }) as HTMLButtonElement;

    await view.findByRole("checkbox", { name: "View one" });
    fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
    await waitFor(() => expect(outer().disabled).toBe(false));
    const answerRunName = holdRunNameCheck();
    fireEvent.click(outer());
    await waitFor(() => expect(ensureOrCheckRunNameAction).toHaveBeenCalled());
    // Taken back while the check is pending: the report is now false.
    fireEvent.click(view.getByRole("checkbox", { name: "View one" }));
    await waitFor(() => expect(outer().disabled).toBe(true));
    await answerRunName();
    await act(async () => {});
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });

  it("a setup field's Continue sends nothing when the renderer reports false during the flush it awaits", async () => {
    replaceTickingRenderer(TICKING_RENDERER_ID, FlushReportsRenderer);
    const view = await mountGate({ xRenderer: TICKING_RENDERER_ID, fieldName: "accountScope" });

    await view.findByText("Flush step");
    await waitFor(() => expect(productContinues()[0]?.disabled).toBe(false));
    // Open when pressed; the flush stages a value and reports false while the
    // press awaits it.
    fireEvent.click(productContinues()[0]!);
    await waitFor(() => expect(productContinues()[0]?.disabled).toBe(true));
    await act(async () => {});
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cinatra#3562, fold 3 — Codex pre-review 2, MUST-FIX 1 to 3.
// ---------------------------------------------------------------------------

/** A list step that reports nothing and hands over one pick per press. */
function SilentListRenderer({ onChange }: FieldRendererProps) {
  return (
    <Button
      type="button"
      onClick={() => void onChange({ scope: "list", listId: "l1", listName: "List one", memberCount: 3 })}
    >
      Pick list one
    </Button>
  );
}

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

function registerAs(id: string, renderer: (props: FieldRendererProps) => React.ReactNode) {
  fieldRendererRegistry.register({
    id,
    priority: 100,
    condition: (_fieldName, schema) => (schema as { "x-renderer"?: unknown })["x-renderer"] === id,
    renderer,
  });
}

describe("OrchestratorStepperPanel — one gate's state and answer stay with that gate (cinatra#3562, fold 3)", () => {
  it("a gate whose parts join to another gate's `::` string gets its own renderer, draft and answer (MUST-FIX 1)", async () => {
    // Gate A: task `setup-a`, field `b::<R>::c`. Gate B: task `setup-a::<R>::b`,
    // field `c`. Joined with `::`, both read `setup-a::<R>::b::<R>::c`.
    const R = CONTROL_LESS_RENDERER_ID;
    const fieldA = `b::${R}::c`;
    expect(["setup-a", R, fieldA].join("::")).toBe([`setup-a::${R}::b`, R, "c"].join("::"));
    const gate = await mountGate({ xRenderer: R, fieldName: fieldA, reviewTaskId: "setup-a" });

    const boxA = () => document.getElementById(`field-${fieldA}`) as HTMLInputElement | null;
    await waitFor(() => expect(boxA()).not.toBeNull());
    fireEvent.change(boxA()!, { target: { value: "for A" } });
    await waitFor(() => expect(boxA()!.value).toBe("for A"));

    gate.advanceTo({ xRenderer: R, fieldName: "c", reviewTaskId: `setup-a::${R}::b` });
    const boxB = () => document.getElementById("field-c") as HTMLInputElement | null;
    await waitFor(() => expect(boxB()).not.toBeNull());
    // B is a question of its own: it starts empty, and a press sends nothing.
    expect(boxB()!.value).toBe("");
    await waitFor(() => expect(productContinues()).toHaveLength(1));
    fireEvent.click(productContinues()[0]!);
    await act(async () => {});
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });

  it("a list step of the next review task starts with no pick: the earlier task's pick is never sent for it (MUST-FIX 2)", async () => {
    const SILENT_LIST_ID = "@cinatra-test/pack-agent-silent:list-picker";
    registerAs(SILENT_LIST_ID, SilentListRenderer);
    const view = await mountGate({
      xRenderer: SILENT_LIST_ID,
      fieldName: "accountScope",
      schema: { type: "object" },
      reviewTaskId: "review-run-3562-a",
    });

    await view.findByRole("button", { name: "Pick list one" });
    fireEvent.click(view.getByRole("button", { name: "Pick list one" }));
    await act(async () => {});

    view.advanceTo({
      xRenderer: SILENT_LIST_ID,
      fieldName: "accountScope",
      reviewTaskId: "review-run-3562-b",
    });
    await view.findByRole("button", { name: "Pick list one" });
    const outer = () => view.getByRole("button", { name: /Continue/ }) as HTMLButtonElement;
    await waitFor(() => expect(outer().disabled).toBe(false));
    fireEvent.click(outer());
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const [taskId, payload] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(taskId).toBe("review-run-3562-b");
    expect(JSON.stringify(payload)).not.toContain("l1");
  });

  it("a list step's pick is the resume text: a buffered reply text does not ride along to shadow it (MUST-FIX 3)", async () => {
    const REPLY_LIST_ID = "@cinatra-test/pack-agent-reply:list-picker";
    registerAs(REPLY_LIST_ID, ReplyListRenderer);
    const view = await mountGate({
      xRenderer: REPLY_LIST_ID,
      fieldName: "accountScope",
      schema: { type: "object" },
      reviewTaskId: "review-run-3562",
    });

    await view.findByRole("button", { name: "Pick with a reply" });
    fireEvent.click(view.getByRole("button", { name: "Pick with a reply" }));
    await act(async () => {});
    const outer = () => view.getByRole("button", { name: /Continue/ }) as HTMLButtonElement;
    await waitFor(() => expect(outer().disabled).toBe(false));
    fireEvent.click(outer());
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
  it("the renderer of the next review task's gate is never drawn with the earlier task's pick (MUST-FIX 2)", async () => {
    // A renderer seeds its own state from the first `value` it is given, so the
    // reset must land before the new gate's renderer draws, not after.
    const drawnWith: unknown[] = [];
    function RecordingListRenderer(props: FieldRendererProps) {
      drawnWith.push(props.value);
      return <SilentListRenderer {...props} />;
    }
    const RECORDING_LIST_ID = "@cinatra-test/pack-agent-recording:list-picker";
    registerAs(RECORDING_LIST_ID, RecordingListRenderer);
    // A field that is not object-typed is given the whole buffer as its value.
    const view = await mountGate({
      xRenderer: RECORDING_LIST_ID,
      fieldName: "accountScope",
      reviewTaskId: "review-run-3562-a",
    });

    await view.findByRole("button", { name: "Pick list one" });
    fireEvent.click(view.getByRole("button", { name: "Pick list one" }));
    await act(async () => {});
    // The earlier task's renderer was given its own pick.
    expect(drawnWith.some((v) => JSON.stringify(v ?? null).includes('"l1"'))).toBe(true);

    const fromHere = drawnWith.length;
    view.advanceTo({
      xRenderer: RECORDING_LIST_ID,
      fieldName: "accountScope",
      reviewTaskId: "review-run-3562-b",
    });
    await view.findByRole("button", { name: "Pick list one" });
    await act(async () => {});
    const drawnForB = drawnWith.slice(fromHere);
    expect(drawnForB.length).toBeGreaterThan(0);
    expect(drawnForB.filter((v) => JSON.stringify(v ?? null).includes('"l1"'))).toEqual([]);
  });
});
