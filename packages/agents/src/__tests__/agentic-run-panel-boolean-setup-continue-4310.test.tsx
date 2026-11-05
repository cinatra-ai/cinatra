// @vitest-environment jsdom
/**
 * cinatra#4310 — THE RUN PANEL'S PER-FIELD BOOLEAN QUESTION HAS A CONTINUE.
 *
 * A per-field setup gate for a boolean input is drawn by the schema-field
 * fallback, whose registry entry declares `drawsOwnSubmit: true`. The panel
 * therefore stages nothing and draws no Continue of its own, and hands every
 * `onChange` straight to the submit. The boolean branch used to call
 * `onChange` on every tick, so the first tick sent `true` and `false` could
 * never be sent.
 *
 * What is pinned here, on this surface:
 *   - the gate draws exactly ONE Continue, beneath the box;
 *   - ticking and unticking the box sends nothing;
 *   - an untouched Continue sends `false`, a ticked one sends `true`, each under
 *     the gate's own field name, and each press sends exactly once, also when a
 *     second press lands in the same tick as the first.
 *
 * And on a MID-RUN gate (an `:output` renderer drawn by the schema floor) whose
 * schema is a boolean: the panel's own outer Continue stays the gate's one
 * control, so the field draws no Continue beside it. The box hands its change
 * to the gate's `onChange` as it did before cinatra#4310, and that handler keeps
 * only an object answer, so the box's `false` is dropped: the box stays ticked
 * on the values envelope and the Continue sends the approval without it. That
 * loss is the same on main and is cinatra#4506; it is pinned here as it is, so
 * a change to it is seen. A custom renderer on a mid-run gate is told
 * `hideSubmit` exactly when the rule answers `true` for its schema.
 *
 * Harness mirrors agentic-run-panel-setup-continue-3532.test.tsx.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/agentic-run-panel-boolean-setup-continue-4310.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { fieldRendererRegistry } from "../field-renderer-registry";
import { SchemaOnlyFloorRenderer } from "../schema-field-renderer";
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
    ownKeys: () => ["ArrowRight", "Check", "CheckIcon", "Loader2", "default"],
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
    runId: "run-4310",
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

const FIELD = "sendFollowUps";
const REVIEW_TASK_ID = "setup-run-4310";

/** The per-field setup gate of this issue. */
const SETUP_INTERRUPT = {
  schema: { type: "boolean" },
  xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
  // The run's other inputs: the panel hands the field this envelope as its
  // `value`, and an object is not a ticked box.
  values: { offeringCompanyWebsite: "https://example.com" },
  reviewTaskId: REVIEW_TASK_ID,
  fieldName: FIELD,
};

/** A MID-RUN gate (`:output`) whose renderer is the schema floor, asked with a
 *  boolean schema and no field name, as a mid-run gate is. */
const MID_RUN_RENDERER_ID = "@cinatra-test/pack-agent:output";
const MID_RUN_TASK_ID = "lg-run-4310";
const MID_RUN_INTERRUPT = {
  schema: { type: "boolean" },
  xRenderer: MID_RUN_RENDERER_ID,
  values: {},
  reviewTaskId: MID_RUN_TASK_ID,
};

/** A custom renderer on a mid-run gate that shows the `hideSubmit` it was told. */
const PROBE_RENDERER_ID = "@cinatra-test/probe-agent:output";
function HideSubmitProbe({ hideSubmit }: FieldRendererProps) {
  return <div data-testid="mid-run-probe" data-hide-submit={hideSubmit === true ? "true" : "false"} />;
}

/** The live interrupt the mocked stream hands the panel. Set per test. */
let INTERRUPT: Record<string, unknown> = SETUP_INTERRUPT;

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => ({
    status: "pending_approval",
    error: null,
    presentationHint: null,
    isLive: true,
    interruptContext: INTERRUPT,
    streamedText: "",
    dataPartFrames: [],
  })),
}));

const PANEL_PROPS = {
  runId: "run-4310",
  initialStatus: "pending_approval",
  initialError: null,
  initialMessages: [],
  agUiEnabled: true,
  templateId: "tmpl-4310",
};

async function renderPanel() {
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  return render(<AgenticRunPanel {...PANEL_PROPS} />);
}

function box(): HTMLElement | null {
  return document.getElementById(`field-${FIELD}`);
}

/** Every button on the page that reads as a Continue. */
function continues(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter((b) =>
    /Continue|Submitting|Continuing/.test(b.textContent ?? ""),
  );
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  fieldRendererRegistry.register({
    id: MID_RUN_RENDERER_ID,
    priority: 100,
    condition: (_fieldName, schema) =>
      (schema as { "x-renderer"?: unknown })["x-renderer"] === MID_RUN_RENDERER_ID,
    renderer: SchemaOnlyFloorRenderer,
    drawsOwnSubmit: true,
  });
  fieldRendererRegistry.register({
    id: PROBE_RENDERER_ID,
    priority: 100,
    condition: (_fieldName, schema) =>
      (schema as { "x-renderer"?: unknown })["x-renderer"] === PROBE_RENDERER_ID,
    renderer: HideSubmitProbe,
  });
  cleanup();
});

afterEach(() => {
  cleanup();
  INTERRUPT = SETUP_INTERRUPT;
  vi.clearAllMocks();
  hitlActions.approveReviewTask.mockReset();
  hitlActions.approveReviewTask.mockResolvedValue({ ok: true as const });
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
});

describe("AgenticRunPanel — a per-field boolean setup question (cinatra#4310)", () => {
  it("draws exactly one Continue beneath the box, and the box opens clear", async () => {
    await renderPanel();
    await waitFor(() => expect(box()).not.toBeNull());
    await waitFor(() => expect(continues()).toHaveLength(1));
    expect(box()!.getAttribute("aria-checked")).toBe("false");
  });

  it("ticking and unticking the box stages the answer and sends nothing", async () => {
    await renderPanel();
    await waitFor(() => expect(box()).not.toBeNull());
    fireEvent.click(box()!);
    await waitFor(() => expect(box()!.getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(box()!);
    await waitFor(() => expect(box()!.getAttribute("aria-checked")).toBe("false"));
    await settle();
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });

  it("Continue with the box untouched sends false, once", async () => {
    await renderPanel();
    await waitFor(() => expect(continues()).toHaveLength(1));
    fireEvent.click(continues()[0]!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    expect(hitlActions.approveReviewTask).toHaveBeenLastCalledWith(
      REVIEW_TASK_ID,
      { [FIELD]: false },
      FIELD,
    );
    await settle();
    expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1);
  });

  it("Continue with the box ticked sends true, once", async () => {
    await renderPanel();
    await waitFor(() => expect(box()).not.toBeNull());
    fireEvent.click(box()!);
    await waitFor(() => expect(box()!.getAttribute("aria-checked")).toBe("true"));
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    fireEvent.click(continues()[0]!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    expect(hitlActions.approveReviewTask).toHaveBeenLastCalledWith(
      REVIEW_TASK_ID,
      { [FIELD]: true },
      FIELD,
    );
    await settle();
    expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1);
  });

  it("presses repeated while the first send is in flight (the Continue disabled) send once", async () => {
    let release: (v: { ok: true }) => void = () => {};
    hitlActions.approveReviewTask.mockImplementationOnce(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          release = resolve;
        }),
    );
    await renderPanel();
    await waitFor(() => expect(continues()).toHaveLength(1));
    const press = continues()[0]!;
    fireEvent.click(press);
    fireEvent.click(press);
    fireEvent.click(press);
    await settle();
    expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1);
    release({ ok: true });
    await settle();
    expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1);
  });

  it("two presses in the same tick send once", async () => {
    let release: (v: { ok: true }) => void = () => {};
    hitlActions.approveReviewTask.mockImplementationOnce(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          release = resolve;
        }),
    );
    await renderPanel();
    await waitFor(() => expect(continues()).toHaveLength(1));
    const press = continues()[0]!;
    act(() => {
      press.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      press.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1);
    release({ ok: true });
    await settle();
    expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1);
  });
});

describe("AgenticRunPanel — a boolean asked on a mid-run gate (cinatra#4310)", () => {
  function midRunBox(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[role="checkbox"]');
  }

  it("draws exactly one Continue, the panel's own, and none beside the box", async () => {
    INTERRUPT = MID_RUN_INTERRUPT;
    await renderPanel();
    await waitFor(() => expect(midRunBox()).not.toBeNull());
    await waitFor(() => expect(continues()).toHaveLength(1));
    expect(continues()[0]!.getAttribute("data-action")).toBe("submit-hitl-screen");
  });

  it("the box opens ticked on the values envelope, a click sends nothing and leaves it ticked, and the one Continue sends the approval once without the box's answer (cinatra#4506)", async () => {
    INTERRUPT = MID_RUN_INTERRUPT;
    await renderPanel();
    await waitFor(() => expect(midRunBox()).not.toBeNull());
    expect(midRunBox()!.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(midRunBox()!);
    await settle();
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    // The box's `false` reached a handler that keeps only an object answer.
    expect(midRunBox()!.getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(continues()).toHaveLength(1));
    fireEvent.click(continues()[0]!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    // The panel's own approval of the gate, under no field name, and nothing else.
    expect(hitlActions.approveReviewTask).toHaveBeenLastCalledWith(
      MID_RUN_TASK_ID,
      expect.objectContaining({ approved: true }),
      undefined,
    );
    const payload = (hitlActions.approveReviewTask.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["approved", "approvedAt"]);
    await settle();
    expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1);
  });

  for (const [title, schema, told] of [
    ["a boolean schema is told hideSubmit", { type: "boolean" }, "true"],
    ["a boolean schema with a non-empty enum is not", { type: "boolean", enum: [true, false] }, "false"],
    ["a string schema is not", { type: "string" }, "false"],
  ] as const) {
    it(`a custom renderer on a mid-run gate: ${title}`, async () => {
      INTERRUPT = { ...MID_RUN_INTERRUPT, schema, xRenderer: PROBE_RENDERER_ID };
      await renderPanel();
      await waitFor(() => expect(screen.queryByTestId("mid-run-probe")).not.toBeNull());
      expect(screen.getByTestId("mid-run-probe").getAttribute("data-hide-submit")).toBe(told);
    });
  }
});
