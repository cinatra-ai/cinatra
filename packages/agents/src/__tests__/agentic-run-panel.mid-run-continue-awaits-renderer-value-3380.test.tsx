// @vitest-environment jsdom
/**
 * cinatra#3380 — A MID-RUN GATE'S CONTINUE WAITS FOR THE VALUE ITS RENDERER
 * MUST PRODUCE.
 *
 * A pick renderer (a list the person picks exactly one row of; nothing is picked
 * for them) writes its answer only when the person picks. The run panel drew
 * the gate's Continue available before that, so a press resumed the run with no
 * answer at all.
 *
 * What is pinned here, on the run panel's mid-run Continue
 * (`data-action="submit-hitl-screen"`):
 *   - a gate whose schema declares a property `"x-required": true` draws its
 *     Continue unavailable before the renderer has written that property, and a
 *     press sends nothing;
 *   - once the renderer writes it, the Continue is available and sends the
 *     renderer's value;
 *   - a gate that declares no such property (here with the object-level
 *     `required: ["decision"]` the email gates carry; no renderer writes
 *     `decision`) keeps its Continue available before any write;
 *   - the published submit for the gate (the descriptor published through
 *     `onActiveGateChange`; no application code calls it at this writing, so the
 *     tests capture and call it) is held by the same rule: before the pick it sends
 *     nothing and rejects; after the pick it sends; on a gate that declares
 *     nothing it sends at once;
 *   - a gate that carries a presentation hint is drawn through the generic
 *     dispatch renderer, which writes nothing, so it is out of the rule: its
 *     Continue and the published submit send at once;
 *   - a gate on a renderer that is not a mid-run binding (no `:output` suffix,
 *     no `midRunHitl` entry) is out of the rule even when its schema declares a
 *     value: the published submit sends at once without that value, as on main;
 *   - neither is a setup gate, even on a renderer that reads as mid-run;
 *   - a later gate on the same renderer starts with nothing: what the earlier
 *     gate's renderer wrote is not the later gate's answer.
 *
 * The renderer here is a stand-in registered under a test id; the rule names no
 * agent and no renderer.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/agentic-run-panel.mid-run-continue-awaits-renderer-value-3380.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { Button } from "@/components/ui/button";
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
    runId: "run-3380",
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
  useAgUiRunStream: vi.fn(() => streamResultFor(DECLARING_SCHEMA)),
}));

/** A manifest-flagged mid-run binding id, as a pack declares one. */
const PICK_RENDERER_ID = "@cinatra-test/pick-agent:pick";
const REVIEW_TASK_ID = "wayflow-task-3380";
const NO_PICK_JSON = JSON.stringify({ noPick: true });
const PICKED_JSON = JSON.stringify({ artifactId: "a-2", representationRevisionId: "r-2" });
/** A renderer id with no `:output` suffix and no `midRunHitl` registry entry. */
const NOT_MID_RUN_RENDERER_ID = "@cinatra-test/plain-agent:plain";

/** The gate declares that its renderer must produce `selectedIdeaJson`. */
const DECLARING_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    selectedIdeaJson: { type: "string", title: "Selected idea (JSON)", "x-required": true },
  },
};

/** A gate that declares no renderer value: the email gates' object-level
 *  `required`, which no renderer writes and the rule does not read. */
const UNDECLARING_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["approve", "revise", "reject"] },
  },
  required: ["decision"],
};

/**
 * A PICK RENDERER: it offers rows, picks nothing for anyone, and writes the pick
 * into both keys when a row is pressed — the shape a pack's chooser commits.
 */
function PickRenderer({ onChange, value }: FieldRendererProps) {
  const [picked, setPicked] = React.useState(false);
  // The real pipeline renderer's shape: a list with nothing to pick answers with
  // a no-pick value from a layout effect when it mounts.
  const emptyOffer = Array.isArray((value as { ideas?: unknown } | null)?.ideas)
    && (value as { ideas: unknown[] }).ideas.length === 0;
  React.useLayoutEffect(() => {
    if (emptyOffer) void onChange({ selectedIdeaJson: NO_PICK_JSON, userResponse: NO_PICK_JSON });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emptyOffer]);
  return (
    <div>
      <Button
        type="button"
        data-testid="pick-row-2"
        data-picked={picked ? "yes" : "no"}
        onClick={() => {
          setPicked(true);
          void onChange({ selectedIdeaJson: PICKED_JSON, userResponse: PICKED_JSON });
        }}
      >
        Idea two
      </Button>
    </div>
  );
}

/** The current values of a gate that carries a presentation hint: such a gate is
 *  drawn through the generic dispatch renderer, which writes nothing. */
const HINT_VALUES: Record<string, unknown> = {
  presentation: {
    type: "card_list",
    title: "Review ideas",
    items: [{ title: "Idea one", description: "First" }],
  },
};

function streamResultFor(
  schema: Record<string, unknown>,
  values: Record<string, unknown> = { ideas: [{ artifactId: "a-1" }, { artifactId: "a-2" }] },
  xRenderer: string = PICK_RENDERER_ID,
  gate: { reviewTaskId?: string; fieldName?: string } = {},
) {
  return {
    status: "pending_approval",
    error: null,
    presentationHint: null,
    isLive: true,
    interruptContext: {
      schema,
      xRenderer,
      values,
      reviewTaskId: gate.reviewTaskId ?? REVIEW_TASK_ID,
      ...(gate.fieldName ? { fieldName: gate.fieldName } : {}),
    },
    streamedText: "",
    dataPartFrames: [],
  };
}

type GateSubmit = (value: Record<string, unknown> | string | number | boolean) => Promise<void>;

async function mountGate(
  schema: Record<string, unknown>,
  onActiveGateChange?: (runId: string, gate: { submit: GateSubmit } | null, instanceId: string) => void,
  values?: Record<string, unknown>,
  xRenderer?: string,
  gate?: { reviewTaskId?: string; fieldName?: string },
) {
  const { useAgUiRunStream } = await import("../use-ag-ui-run-stream");
  (useAgUiRunStream as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
    streamResultFor(schema, values, xRenderer, gate),
  );
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  const panel = () => (
    <AgenticRunPanel
      runId="run-3380"
      initialStatus="pending_approval"
      initialError={null}
      initialMessages={[]}
      agUiEnabled={true}
      templateId="tmpl-3380"
      {...(onActiveGateChange ? { onActiveGateChange } : {})}
    />
  );
  const view = render(panel());
  /** The run moves to another gate with the SAME renderer and no field name. */
  const moveToGate = async (reviewTaskId: string, nextValues?: Record<string, unknown>) => {
    (useAgUiRunStream as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      streamResultFor(schema, nextValues ?? values, xRenderer, { reviewTaskId }),
    );
    view.rerender(panel());
  };
  return { ...view, moveToGate };
}

function gateContinue(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('[data-action="submit-hitl-screen"]');
}

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  fieldRendererRegistry.register({
    id: PICK_RENDERER_ID,
    priority: 100,
    condition: (_fieldName, schema) =>
      (schema as { "x-renderer"?: unknown })["x-renderer"] === PICK_RENDERER_ID,
    renderer: PickRenderer,
    midRunHitl: true,
  });
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
});

describe("AgenticRunPanel — a mid-run Continue waits for the renderer's declared value (cinatra#3380)", () => {
  it("draws the Continue unavailable before a row is picked, and a press sends nothing", async () => {
    await mountGate(DECLARING_SCHEMA);

    await waitFor(() => expect(document.querySelector('[data-testid="pick-row-2"]')).not.toBeNull());
    await waitFor(() => expect(gateContinue()).not.toBeNull());
    expect(gateContinue()!.disabled).toBe(true);

    fireEvent.click(gateContinue()!);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });

  it("makes the Continue available once the renderer writes the pick, and sends that pick", async () => {
    await mountGate(DECLARING_SCHEMA);

    await waitFor(() => expect(document.querySelector('[data-testid="pick-row-2"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-testid="pick-row-2"]')!);

    await waitFor(() => expect(gateContinue()!.disabled).toBe(false));
    fireEvent.click(gateContinue()!);

    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const [taskId, payload] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(taskId).toBe(REVIEW_TASK_ID);
    expect(payload.selectedIdeaJson).toBe(PICKED_JSON);
    expect(payload.userResponse).toBe(PICKED_JSON);
    expect(payload.approved).toBe(true);
  });

  it("holds the published submit by the same rule: nothing is sent before the pick, the pick's value after it", async () => {
    const published: { submit: GateSubmit | null } = { submit: null };
    await mountGate(DECLARING_SCHEMA, (_runId, gate) => {
      if (gate) published.submit = gate.submit;
    });

    await waitFor(() => expect(published.submit).not.toBeNull());
    await waitFor(() => expect(document.querySelector('[data-testid="pick-row-2"]')).not.toBeNull());
    await expect(published.submit!("Use the second idea")).rejects.toThrow(/waiting for a choice/);
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();

    fireEvent.click(document.querySelector('[data-testid="pick-row-2"]')!);
    await waitFor(() => expect(gateContinue()!.disabled).toBe(false));
    await published.submit!("Use the second idea");
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const [, payload] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(payload.selectedIdeaJson).toBe(PICKED_JSON);
  });

  it("lets the published submit send at once on a gate that declares no renderer value", async () => {
    const published: { submit: GateSubmit | null } = { submit: null };
    await mountGate(UNDECLARING_SCHEMA, (_runId, gate) => {
      if (gate) published.submit = gate.submit;
    });

    await waitFor(() => expect(published.submit).not.toBeNull());
    await published.submit!("approve");
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
  });

  it("leaves a gate that declares no renderer value unchanged: its Continue is available before any write", async () => {
    await mountGate(UNDECLARING_SCHEMA);

    await waitFor(() => expect(gateContinue()).not.toBeNull());
    expect(gateContinue()!.disabled).toBe(false);

    fireEvent.click(gateContinue()!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
  });

  it("keeps a gate with a presentation hint out of the hold: its Continue is available before any write and sends", async () => {
    await mountGate(DECLARING_SCHEMA, undefined, HINT_VALUES);

    await waitFor(() => expect(gateContinue()).not.toBeNull());
    expect(document.querySelector('[data-testid="pick-row-2"]')).toBeNull();
    expect(gateContinue()!.disabled).toBe(false);

    fireEvent.click(gateContinue()!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
  });

  it("lets the published submit send at once on a gate with a presentation hint", async () => {
    const published: { submit: GateSubmit | null } = { submit: null };
    await mountGate(
      DECLARING_SCHEMA,
      (_runId, gate) => {
        if (gate) published.submit = gate.submit;
      },
      HINT_VALUES,
    );

    await waitFor(() => expect(published.submit).not.toBeNull());
    await published.submit!("approve");
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
  });

  it("lets the published submit send at once, without the value, on a declaring gate whose renderer is not a mid-run binding", async () => {
    const published: { submit: GateSubmit | null } = { submit: null };
    await mountGate(
      DECLARING_SCHEMA,
      (_runId, gate) => {
        if (gate) published.submit = gate.submit;
      },
      undefined,
      NOT_MID_RUN_RENDERER_ID,
    );

    await waitFor(() => expect(published.submit).not.toBeNull());
    await published.submit!("approve");
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const [taskId, payload] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(taskId).toBe(REVIEW_TASK_ID);
    expect(payload.selectedIdeaJson).toBeUndefined();
  });

  it("holds the published submit on a gate whose renderer has the :output suffix and no binding", async () => {
    const published: { submit: GateSubmit | null } = { submit: null };
    await mountGate(
      DECLARING_SCHEMA,
      (_runId, gate) => {
        if (gate) published.submit = gate.submit;
      },
      undefined,
      "@cinatra-test/plain-agent:output",
    );

    await waitFor(() => expect(published.submit).not.toBeNull());
    await expect(published.submit!("approve")).rejects.toThrow(/waiting for a choice/);
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });

  it("does not hold the published submit on a setup gate, even on a renderer that reads as mid-run", async () => {
    const published: { submit: GateSubmit | null } = { submit: null };
    await mountGate(
      DECLARING_SCHEMA,
      (_runId, gate) => {
        if (gate) published.submit = gate.submit;
      },
      undefined,
      "@cinatra-test/plain-agent:output",
      { reviewTaskId: "setup-run-3380", fieldName: "config" },
    );

    await waitFor(() => expect(published.submit).not.toBeNull());
    await published.submit!({ config: {} });
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const [taskId, payload] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(taskId).toBe("setup-run-3380");
    expect(payload.selectedIdeaJson).toBeUndefined();
  });

  it("starts a later gate on the same renderer with nothing: the Continue and the published submit are held again, and the later pick is sent for the later gate", async () => {
    const published: { submit: GateSubmit | null } = { submit: null };
    const view = await mountGate(DECLARING_SCHEMA, (_runId, gate) => {
      if (gate) published.submit = gate.submit;
    });

    await waitFor(() => expect(document.querySelector('[data-testid="pick-row-2"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-testid="pick-row-2"]')!);
    await waitFor(() => expect(gateContinue()!.disabled).toBe(false));

    await view.moveToGate("wayflow-task-3380-next");

    await waitFor(() => expect(gateContinue()!.disabled).toBe(true));
    expect(document.querySelector('[data-testid="pick-row-2"]')!.getAttribute("data-picked")).toBe("no");
    fireEvent.click(gateContinue()!);
    await expect(published.submit!("Use the second idea")).rejects.toThrow(/waiting for a choice/);
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();

    fireEvent.click(document.querySelector('[data-testid="pick-row-2"]')!);
    await waitFor(() => expect(gateContinue()!.disabled).toBe(false));
    fireEvent.click(gateContinue()!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const [taskId, payload] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(taskId).toBe("wayflow-task-3380-next");
    expect(payload.selectedIdeaJson).toBe(PICKED_JSON);
  });

  it("keeps what a later gate's renderer writes when it mounts: a list with nothing to pick is answered, and the Continue sends that answer", async () => {
    const view = await mountGate(DECLARING_SCHEMA);

    await waitFor(() => expect(document.querySelector('[data-testid="pick-row-2"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-testid="pick-row-2"]')!);
    await waitFor(() => expect(gateContinue()!.disabled).toBe(false));

    await view.moveToGate("wayflow-task-3380-empty", { ideas: [] });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await waitFor(() => expect(gateContinue()!.disabled).toBe(false));
    fireEvent.click(gateContinue()!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const [taskId, payload] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(taskId).toBe("wayflow-task-3380-empty");
    expect(payload.selectedIdeaJson).toBe(NO_PICK_JSON);
  });
});
