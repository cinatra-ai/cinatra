// @vitest-environment jsdom
/**
 * cinatra#2557 — the chat / run-detail HITL SUGGESTION buffer
 * (`bufferedHitlValue`) reset on renderer-TYPE change ONLY, not per field.
 *
 * The stepper already keys its buffer with a fieldName-inclusive `bufferKey`
 * (orchestrator-stepper-panel.tsx, cinatra#810). AgenticRunPanel's buffer
 * reset predates that pattern: it only compared the tracked `xRenderer`
 * string, so a value merged into the buffer for field 1 (e.g. an AI-assist
 * SUGGESTION applied via `onApply`) survived a same-xRenderer advance to
 * field 2 and rode along in field 2's `value` prop
 * (`{...currentValues, ...bufferedHitlValue}`).
 *
 * Typed-input carryover through a renderer's own LOCAL state was already
 * fixed by the composite React `key={xRenderer::fieldName}` (cinatra#2541,
 * PR #2556) — that fix remounts the renderer component itself on a field
 * advance. It does NOT touch the parent-level `bufferedHitlValue` state,
 * which a fresh renderer instance still reads on mount via its `value` prop.
 * This is what this file pins.
 *
 * A registry-matched custom renderer (unlike the schema-field-fallback
 * floor's SchemaFieldRenderer, which only ever treats a string/number/array
 * `value` as displayable) receives the RAW merged envelope for a
 * non-object-typed field verbatim (`setupFieldRendererValue` only scopes by
 * fieldName for OBJECT-typed fields — see hitl-gate-submit.ts) — exactly how
 * a real custom HITL renderer (gmail-sender, campaign-recipients, etc.)
 * would. The probe renderer registered below stands in for one: it renders
 * `value` verbatim and exposes an "Apply" affordance that calls `onApply`
 * directly — the same prop the real AI-assist Suggest flow calls after its
 * fetch resolves — so the buffer is seeded WITHOUT typing anything.
 *
 * Harness mirrors agentic-run-panel-hitl-field-label.test.tsx.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/agentic-run-panel-hitl-suggestion-buffer.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { fieldRendererRegistry, type FieldRendererProps } from "../field-renderer-registry";

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
    runId: "run-2557",
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
  useAgUiRunStream: vi.fn(() => streamResultFor("field1")),
}));

const PROBE_RENDERER_ID = "@cinatra-ai/agents:test-2557-suggestion-probe";
const SECOND_PROBE_RENDERER_ID = "@cinatra-ai/agents:test-2557-suggestion-probe-b";

/** Stands in for a real custom HITL renderer: shows `value` verbatim and
 *  exposes an "Apply" affordance calling `onApply` directly — the SAME prop
 *  the real AI-assist Suggest flow drives, without going through PromptField
 *  (stubbed inert above) or typing. */
function SuggestionProbeRenderer(props: FieldRendererProps) {
  return (
    <div>
      <div data-testid={`value-${props.fieldName}`}>{JSON.stringify(props.value ?? null)}</div>
      {/* Not a real affordance — a test-only clickable probe, so the raw
       *  shadcn <Button> wrapper (unrelated to what this file is testing)
       *  is not warranted here. */}
      <div
        role="button"
        tabIndex={0}
        data-testid={`apply-${props.fieldName}`}
        onClick={() => props.onApply?.({ greeting: "SUGGESTED_FOR_FIELD_ONE" })}
      >
        Apply suggestion
      </div>
    </div>
  );
}

/** An AG-UI stream result parked on a single-field setup gate, using the
 *  PROBE renderer's xRenderer id so RENDERER SELECTION (keyed on the
 *  placeholder, not fieldName — see agentic-run-panel.tsx) resolves it. */
function streamResultFor(fieldName: string | undefined) {
  return {
    status: "pending_approval",
    error: null,
    presentationHint: null,
    isLive: true,
    interruptContext: {
      schema: { type: "string" },
      xRenderer: PROBE_RENDERER_ID,
      values: {},
      reviewTaskId: "setup-run-2557",
      ...(fieldName === undefined ? {} : { fieldName }),
    },
    streamedText: "",
    dataPartFrames: [],
  };
}

const PANEL_PROPS = {
  runId: "run-2557",
  initialStatus: "pending_approval",
  initialError: null,
  initialMessages: [],
  agUiEnabled: true,
  templateId: "tmpl-2557",
};

async function renderPanel() {
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  const view = render(<AgenticRunPanel {...PANEL_PROPS} />);
  return {
    ...view,
    rerenderPanel: () => view.rerender(<AgenticRunPanel {...PANEL_PROPS} />),
  };
}

async function setGate(fieldName: string | undefined) {
  const { useAgUiRunStream } = await import("../use-ag-ui-run-stream");
  (useAgUiRunStream as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
    streamResultFor(fieldName),
  );
}

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  fieldRendererRegistry.register({
    id: PROBE_RENDERER_ID,
    priority: 90,
    condition: (_fieldName, schema) => (schema as { ["x-renderer"]?: unknown })["x-renderer"] === PROBE_RENDERER_ID,
    renderer: SuggestionProbeRenderer,
  });
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgenticRunPanel — the HITL suggestion buffer is keyed per field (cinatra#2557)", () => {
  it("a SUGGESTION applied for field 1 does not bleed into field 2 under the SAME xRenderer", async () => {
    await setGate("field1");
    const view = await renderPanel();

    await waitFor(() => expect(view.getByTestId("value-field1")).not.toBeNull());
    // Field 1 starts unsuggested.
    expect(view.getByTestId("value-field1").textContent).toBe("{}");

    // Seed the SUGGESTION buffer for field 1 — NOT keyboard input. This calls
    // the same `onApply` prop the real AI-assist flow calls after its fetch
    // resolves (`handleApply` in agentic-run-panel.tsx).
    fireEvent.click(view.getByTestId("apply-field1"));
    await waitFor(() =>
      expect(view.getByTestId("value-field1").textContent).toBe(
        JSON.stringify({ greeting: "SUGGESTED_FOR_FIELD_ONE" }),
      ),
    );

    // The setup loop advances: SAME xRenderer, next field, no RESUME frame —
    // exactly the shape #2556 fixed for typed input on this surface.
    await setGate("field2");
    view.rerenderPanel();

    await waitFor(() => expect(view.getByTestId("value-field2")).not.toBeNull());
    // Field 2 must render UNSUGGESTED — field 1's buffered suggestion must
    // not survive the advance.
    expect(view.getByTestId("value-field2").textContent).toBe("{}");
    expect(document.body.textContent).not.toMatch(/SUGGESTED_FOR_FIELD_ONE/);
  });

  // A FIELDLESS gate (the shape a mid-run gate's interrupt carries — no
  // `fieldName` at all) rather than a specific `isMidRunHitl`-classified
  // renderer: the buffer-reset logic under test only ever branches on
  // `xRenderer`/`fieldName`, so the fieldless key shape is what actually
  // matters here, independent of mid-run classification.
  it("a fieldless gate (the shape a mid-run gate carries) still resets its buffer on xRenderer change alone (AC3 — unchanged)", async () => {
    await setGate(undefined);
    const view = await renderPanel();

    await waitFor(() => expect(view.getByTestId("value-hitl-field")).not.toBeNull());
    fireEvent.click(view.getByTestId("apply-hitl-field"));
    await waitFor(() =>
      expect(view.getByTestId("value-hitl-field").textContent).toBe(
        JSON.stringify({ greeting: "SUGGESTED_FOR_FIELD_ONE" }),
      ),
    );

    // A DIFFERENT xRenderer arrives (still no fieldName) — the existing
    // xRenderer-only reset must still fire, unchanged.
    const { useAgUiRunStream } = await import("../use-ag-ui-run-stream");
    (useAgUiRunStream as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      status: "pending_approval",
      error: null,
      presentationHint: null,
      isLive: true,
      interruptContext: {
        schema: { type: "string" },
        xRenderer: SECOND_PROBE_RENDERER_ID,
        values: {},
        reviewTaskId: "midrun-run-2557",
      },
      streamedText: "",
      dataPartFrames: [],
    });
    fieldRendererRegistry.register({
      id: SECOND_PROBE_RENDERER_ID,
      priority: 90,
      condition: (_fieldName, schema) =>
        (schema as { ["x-renderer"]?: unknown })["x-renderer"] === SECOND_PROBE_RENDERER_ID,
      renderer: SuggestionProbeRenderer,
    });
    view.rerenderPanel();

    await waitFor(() => expect(view.getByTestId("value-hitl-field")).not.toBeNull());
    expect(view.getByTestId("value-hitl-field").textContent).toBe("{}");
  });
});
