// @vitest-environment jsdom
/**
 * The chat / run-detail half of the cinatra#2541 seam.
 *
 * AgenticRunPanel carried the SAME hardcoded `fieldName="hitl-field"` as the
 * orchestrator stepper, so a per-field setup gate labelled itself "Hitl Field"
 * here too. Passing the interrupt's real field name has a consequence this
 * surface did not previously have to handle: `fieldName` now CHANGES between
 * sequential setup gates, which share one xRenderer and arrive with no
 * RUN_STARTED/RESUME frame between them. An xRenderer-only React key would keep
 * the same renderer instance alive across that advance and mutate its field
 * identity in place — field 1's typed text (SchemaFieldRenderer's `localValue`,
 * which a non-string incoming value does not clear) would sit under field 2's
 * label. The stepper already solved this with a composite key (#810); this
 * surface adopts it here, and the second test below is what pins it.
 *
 * Harness mirrors agentic-run-panel.hitl.test.tsx.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/agentic-run-panel-hitl-field-label.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { GENERIC_FIELD_LABEL } from "../humanize-field-name";

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
    ownKeys: () => [
      "ArrowRight",
      "Check",
      "CheckCircle2",
      "ChevronDown",
      "Circle",
      "CircleDot",
      "ClipboardList",
      "ExternalLink",
      "Loader2",
      "XCircle",
      "default",
    ],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => undefined),
  rejectReviewTask: vi.fn(async () => undefined),
}));

vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(async () => null),
}));

vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-2541",
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
  useAgUiRunStream: vi.fn(() => streamResultFor("idea", { type: "string" })),
}));

/** An AG-UI stream result parked on a single-field setup gate. */
function streamResultFor(
  fieldName: string | undefined,
  schema: Record<string, unknown>,
) {
  return {
    status: "pending_approval",
    error: null,
    presentationHint: null,
    isLive: true,
    interruptContext: {
      schema,
      xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
      values: {},
      reviewTaskId: "setup-run-2541",
      ...(fieldName === undefined ? {} : { fieldName }),
    },
    streamedText: "",
    dataPartFrames: [],
  };
}

const PANEL_PROPS = {
  runId: "run-2541",
  initialStatus: "pending_approval",
  initialError: null,
  initialMessages: [],
  agUiEnabled: true,
  templateId: "tmpl-2541",
};

/**
 * Mount the panel and hand back a `rerender` that re-renders the SAME element
 * type — so the tree is reconciled rather than replaced, and only a changed
 * React key can remount the field renderer.
 */
async function renderPanel() {
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  const view = render(<AgenticRunPanel {...PANEL_PROPS} />);
  return {
    ...view,
    rerenderPanel: () => view.rerender(<AgenticRunPanel {...PANEL_PROPS} />),
  };
}

async function setGate(fieldName: string | undefined, schema: Record<string, unknown>) {
  const { useAgUiRunStream } = await import("../use-ag-ui-run-stream");
  (useAgUiRunStream as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
    streamResultFor(fieldName, schema),
  );
}

function labelFor(fieldId: string): HTMLLabelElement | null {
  return document.querySelector<HTMLLabelElement>(`label[for="${fieldId}"]`);
}

function inputFor(fieldId: string): HTMLInputElement | HTMLTextAreaElement | null {
  return document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${fieldId}`);
}

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgenticRunPanel — the HITL gate labels itself from the REAL field name (cinatra#2541)", () => {
  it("labels a titleless `idea` setup gate 'Idea', not 'Hitl Field'", async () => {
    await setGate("idea", { type: "string" });
    await renderPanel();

    await waitFor(() => expect(labelFor("field-idea")).not.toBeNull());
    expect(labelFor("field-idea")!.textContent).toMatch(/^Idea/);
    expect(document.body.textContent).not.toMatch(/Hitl Field/i);
    expect(document.querySelector("#field-hitl-field")).toBeNull();
  });

  it("humanizes a title-equals-key gate through the panel (#1162 shape)", async () => {
    await setGate("blogPostUrl", { type: "string", title: "blogPostUrl" });
    await renderPanel();

    await waitFor(() => expect(labelFor("field-blogPostUrl")).not.toBeNull());
    expect(labelFor("field-blogPostUrl")!.textContent).toMatch(/^Blog Post URL/);
    expect(document.body.textContent).not.toMatch(/Hitl Field/i);
  });

  it("falls back to a NEUTRAL label when the interrupt carries no field name", async () => {
    await setGate(undefined, { type: "string" });
    await renderPanel();

    await waitFor(() => expect(labelFor("field-hitl-field")).not.toBeNull());
    expect(labelFor("field-hitl-field")!.textContent).toMatch(
      new RegExp(`^${GENERIC_FIELD_LABEL}`),
    );
    expect(document.body.textContent).not.toMatch(/Hitl Field/i);
  });

  it("REMOUNTS the renderer when the setup loop advances to the next field — no text carryover", async () => {
    // The hazard the composite key exists for: field 1 and field 2 share one
    // xRenderer, so an xRenderer-only key kept ONE instance alive and merely
    // swapped its `fieldName` — carrying field 1's typed text into field 2.
    await setGate("brief", { type: "string" });
    const view = await renderPanel();

    await waitFor(() => expect(inputFor("field-brief")).not.toBeNull());
    // Type into field 1 the way a user does. SchemaFieldRenderer buffers this in
    // component-local state (`localValue`), which only a remount clears — the
    // incoming value for the next gate is an object envelope, and the sync
    // effect ignores non-string/number/array values.
    fireEvent.change(inputFor("field-brief")!, {
      target: { value: "a brief the user typed for FIELD ONE" },
    });
    expect((inputFor("field-brief") as HTMLInputElement).value).toBe(
      "a brief the user typed for FIELD ONE",
    );

    // The setup loop advances: same xRenderer, next field, no RESUME frame.
    await setGate("audience", { type: "string" });
    view.rerenderPanel();

    await waitFor(() => expect(inputFor("field-audience")).not.toBeNull());
    expect(labelFor("field-audience")!.textContent).toMatch(/^Audience/);
    // Field 1's input is gone, and field 2 starts EMPTY.
    expect(inputFor("field-brief")).toBeNull();
    expect((inputFor("field-audience") as HTMLInputElement).value).toBe("");
  });
});
