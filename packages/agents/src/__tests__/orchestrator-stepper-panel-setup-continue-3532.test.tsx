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
 * Harness mirrors orchestrator-stepper-hitl-field-label.test.tsx.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/orchestrator-stepper-panel-setup-continue-3532.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

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
  return { ...view, advanceTo };
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

beforeEach(() => {
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
});
