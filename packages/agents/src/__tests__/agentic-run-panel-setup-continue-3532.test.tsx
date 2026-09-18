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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

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
      reviewTaskId: "setup-run-3532",
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
) {
  const { useAgUiRunStream } = await import("../use-ag-ui-run-stream");
  (useAgUiRunStream as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
    streamResultFor(xRenderer, fieldName, schema),
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
