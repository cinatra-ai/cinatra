// @vitest-environment jsdom
/**
 * cinatra#3358 — A REQUIRED SETUP FIELD LEFT EMPTY SHOWS AN ERROR ON CONTINUE;
 * AN OPTIONAL ONE DOES NOT.
 *
 * The maintainer's rule of 2026-09-23, on the run page and the chat's inline
 * card: when Continue is pressed on a per-field setup gate, an empty required
 * field shows an error and nothing is sent; an empty optional field — one whose
 * own schema declares a `default`, which the server settles it with
 * (cinatra#3452) — shows no error and the step is sent.
 *
 * Harness mirrors agentic-run-panel-setup-continue-3532.test.tsx.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/agentic-run-panel-setup-empty-press.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { Input } from "@/components/ui/input";
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

const toastMock = vi.hoisted(() => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/cinatra-toast", () => toastMock);

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
 * A PACK-SHAPED RENDERER THAT DRAWS NO SUBMIT CONTROL, registered without
 * `drawsOwnSubmit`, so the product draws the Continue beside it.
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
 * A RENDERER THAT HOLDS THE READER'S TEXT LOCALLY and hands it over only when
 * asked (its registered flush), also registered without `drawsOwnSubmit`.
 */
const FLUSH_ONLY_RENDERER_ID = "@cinatra-test/pack-agent:flush-only";

function FlushOnlyRenderer({ fieldName, onChange, registerFlush }: FieldRendererProps) {
  const [local, setLocal] = React.useState("");
  const localRef = React.useRef("");
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
      onChange={(e) => {
        localRef.current = e.target.value;
        setLocal(e.target.value);
      }}
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

const NO_ANSWER = "Add an answer before continuing.";

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

function box(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>("#field-callToAction");
}

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  // The pack-shaped entry: no `drawsOwnSubmit`, so it declares no submit
  // control of its own.
  fieldRendererRegistry.register({
    id: CONTROL_LESS_RENDERER_ID,
    priority: 100,
    condition: (_fieldName, schema) =>
      (schema as { "x-renderer"?: unknown })["x-renderer"] === CONTROL_LESS_RENDERER_ID,
    renderer: ControlLessRenderer,
  });
  fieldRendererRegistry.register({
    id: FLUSH_ONLY_RENDERER_ID,
    priority: 100,
    condition: (_fieldName, schema) =>
      (schema as { "x-renderer"?: unknown })["x-renderer"] === FLUSH_ONLY_RENDERER_ID,
    renderer: FlushOnlyRenderer,
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

describe("AgenticRunPanel — a required setup field left empty shows an error on Continue; an optional one does not (cinatra#3358)", () => {
  it("a required field left empty: the error, and nothing sent (S4a)", async () => {
    await setGate(CONTROL_LESS_RENDERER_ID, "callToAction", { type: "string" });
    await renderPanel();

    await waitFor(() => expect(box()).not.toBeNull());
    await waitFor(() => expect(productContinue()).not.toBeNull());
    fireEvent.click(productContinue()!);

    await waitFor(() => expect(toastMock.toast.error).toHaveBeenCalledWith(NO_ANSWER));
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    expect(box()).not.toBeNull();
  });

  it("a required field typed into and cleared: the error, and nothing sent (S4b)", async () => {
    await setGate(CONTROL_LESS_RENDERER_ID, "callToAction", { type: "string" });
    await renderPanel();

    await waitFor(() => expect(box()).not.toBeNull());
    fireEvent.change(box()!, { target: { value: "Book" } });
    await waitFor(() => expect(box()!.value).toBe("Book"));
    fireEvent.change(box()!, { target: { value: "" } });
    await waitFor(() => expect(box()!.value).toBe(""));
    await waitFor(() => expect(productContinue()).not.toBeNull());
    fireEvent.click(productContinue()!);

    await waitFor(() => expect(toastMock.toast.error).toHaveBeenCalledWith(NO_ANSWER));
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    expect(box()).not.toBeNull();
  });

  it("a field that declares a default, left empty: no error, and the step is sent (S4c)", async () => {
    await setGate(CONTROL_LESS_RENDERER_ID, "callToAction", {
      type: "string",
      default: "Book a demo",
    });
    await renderPanel();

    await waitFor(() => expect(box()).not.toBeNull());
    await waitFor(() => expect(productContinue()).not.toBeNull());
    fireEvent.click(productContinue()!);

    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    expect(hitlActions.approveReviewTask).toHaveBeenCalledWith(
      "setup-run-3532",
      { callToAction: null },
      "callToAction",
    );
    expect(toastMock.toast.error).not.toHaveBeenCalled();
  });

  it("a buffering field flushed empty is refused, and the answer typed after it is sent (S4d)", async () => {
    await setGate(FLUSH_ONLY_RENDERER_ID, "callToAction", {
      type: "string",
      "x-renderer": FLUSH_ONLY_RENDERER_ID,
    });
    await renderPanel();

    await waitFor(() => expect(box()).not.toBeNull());
    await waitFor(() => expect(productContinue()).not.toBeNull());
    fireEvent.click(productContinue()!);

    await waitFor(() => expect(toastMock.toast.error).toHaveBeenCalledWith(NO_ANSWER));
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();

    fireEvent.change(box()!, { target: { value: "Book a meeting" } });
    await waitFor(() => expect(box()!.value).toBe("Book a meeting"));
    await waitFor(() => expect(productContinue()!.disabled).toBe(false));
    fireEvent.click(productContinue()!);

    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    expect(hitlActions.approveReviewTask).toHaveBeenCalledWith(
      "setup-run-3532",
      { callToAction: "Book a meeting" },
      "callToAction",
    );
  });

  it("a required field whose declared default is empty, left empty: the error, and nothing sent (D3)", async () => {
    await setGate(CONTROL_LESS_RENDERER_ID, "callToAction", {
      type: "string",
      default: "",
    });
    await renderPanel();

    await waitFor(() => expect(box()).not.toBeNull());
    await waitFor(() => expect(productContinue()).not.toBeNull());
    fireEvent.click(productContinue()!);

    await waitFor(() => expect(toastMock.toast.error).toHaveBeenCalledWith(NO_ANSWER));
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    expect(box()).not.toBeNull();
  });
});
