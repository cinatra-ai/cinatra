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
}) {
  INTERRUPT = {
    schema: args.schema ?? { type: "string" },
    xRenderer: args.xRenderer,
    values: {},
    reviewTaskId: args.reviewTaskId ?? "setup-run-3532",
    fieldName: args.fieldName,
  };
  const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
  const view = render(<OrchestratorStepperPanel {...baseProps()} />);
  /** Advance the live gate under the mounted panel, as the setup loop does. */
  const advanceTo = (next: { xRenderer: string; fieldName: string }) => {
    INTERRUPT = {
      schema: args.schema ?? { type: "string" },
      xRenderer: next.xRenderer,
      values: {},
      reviewTaskId: args.reviewTaskId ?? "setup-run-3532",
      fieldName: next.fieldName,
    };
    view.rerender(<OrchestratorStepperPanel {...baseProps()} />);
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
