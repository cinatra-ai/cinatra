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
 *     the gate's own field name, and each press sends exactly once.
 *
 * Harness mirrors agentic-run-panel-setup-continue-3532.test.tsx.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/agentic-run-panel-boolean-setup-continue-4310.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { fieldRendererRegistry } from "../field-renderer-registry";

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

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => ({
    status: "pending_approval",
    error: null,
    presentationHint: null,
    isLive: true,
    interruptContext: {
      schema: { type: "boolean" },
      xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
      // The run's other inputs: the panel hands the field this envelope as its
      // `value`, and an object is not a ticked box.
      values: { offeringCompanyWebsite: "https://example.com" },
      reviewTaskId: REVIEW_TASK_ID,
      fieldName: FIELD,
    },
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
  cleanup();
});

afterEach(() => {
  cleanup();
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

  it("a press repeated while the first send is in flight sends once", async () => {
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
});
