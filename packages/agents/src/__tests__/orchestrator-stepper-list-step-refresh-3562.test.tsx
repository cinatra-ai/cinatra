// @vitest-environment jsdom
/**
 * cinatra#3562 — THE STEPPER SENDS A LIST STEP'S TRY AGAIN AT ONCE.
 *
 * With no list to pick, the list step draws Try again (design
 * specs/app-artifact-review.html I.1, the failed-read alert). A press writes
 * `{ listIds: [], listNames: [], refresh: "refresh" }` and the step reports its
 * value unsendable, so the Continue stays unavailable. The stepper sends that
 * write at once as the step's answer, with the refresh value as the resume
 * text: once per press, never as a pick, and only on a mid-run list step.
 *
 * Harness mirrors orchestrator-stepper-panel-setup-continue-3532.test.tsx.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/orchestrator-stepper-list-step-refresh-3562.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { Button } from "@/components/ui/button";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { fieldRendererRegistry } from "../field-renderer-registry";
import type { FieldRendererProps } from "../field-renderer-registry";

const LIST_STEP_ID = "@cinatra-ai/email-outreach-agent:list-picker";
const WAYFLOW_TASK = "wayflow-task-3562";

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
 * that needs the card's attachment road calls the `onSubmit` the panel is
 * handed, which is the road the paperclip takes. Since cinatra#3487 the run
 * page's chrome draws the panel and hands it the submit the card lent the
 * chrome. The panel itself is the real one, drawn with the same props.
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

/** The list step with no list to pick: it reports `false` and draws Try again. */
function TryAgainRenderer({ onChange, onValidityChange }: FieldRendererProps) {
  React.useEffect(() => {
    onValidityChange?.(false);
  }, [onValidityChange]);
  return (
    <Button
      type="button"
      data-testid="list-picker-try-again"
      onClick={() => void onChange({ listIds: [], listNames: [], refresh: "refresh" })}
    >
      Try again
    </Button>
  );
}

async function mountOn(reviewTaskId: string) {
  INTERRUPT = {
    schema: { type: "object", properties: { accountScope: { type: "string" } } },
    xRenderer: LIST_STEP_ID,
    values: {},
    reviewTaskId,
  };
  const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
  return render(
    <OrchestratorStepperPanel
      runId="run-3562"
      initialStatus="pending_approval"
      initialError={null}
      agUiEnabled={false}
      agentPackageName="@cinatra-ai/email-outreach-agent"
      inputParams={{}}
      stepperSteps={[{ index: 1, stepNumber: 1, label: "Account scope", xRenderer: LIST_STEP_ID }]}
      agentId="cinatra-ai/email-outreach-agent"
      lgThreadId={null}
      templateId="tmpl-3562"
      templateName="Email Outreach Agent"
    />,
  );
}

/** The stepper's mid-run Continue, drawn below the step. */
function productContinue(): HTMLButtonElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      /^Continu/.test(b.textContent ?? ""),
    ) ?? null
  );
}

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  fieldRendererRegistry.register({
    id: LIST_STEP_ID,
    priority: 100,
    condition: (_fieldName, schema) =>
      (schema as { "x-renderer"?: unknown })["x-renderer"] === LIST_STEP_ID,
    renderer: TryAgainRenderer,
    drawsOwnSubmit: true,
  });
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  INTERRUPT = null;
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
});

describe("OrchestratorStepperPanel — a list step's Try again (cinatra#3562)", () => {
  it("sends the refresh value at once as the step's answer, never as a pick, and keeps Continue unavailable", async () => {
    const view = await mountOn(WAYFLOW_TASK);
    const tryAgain = await view.findByTestId("list-picker-try-again");
    await waitFor(() => expect(productContinue()!.disabled).toBe(true));

    fireEvent.click(tryAgain);
    // red-first-expect: to be called 1 times, but got 0 times
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const [taskId, payload, fieldName] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      string | undefined,
    ];
    expect(taskId).toBe(WAYFLOW_TASK);
    expect(fieldName).toBeUndefined();
    expect(payload).toMatchObject({ userResponse: "refresh", listStepRefresh: "refresh" });
    expect(payload).not.toHaveProperty("approvalNote");
    expect(payload).not.toHaveProperty("listIds");
  });

  it("sends once for a double press", async () => {
    let finish: (value: { ok: true }) => void = () => {};
    hitlActions.approveReviewTask.mockImplementationOnce(
      () => new Promise<{ ok: true }>((resolve) => (finish = resolve)),
    );
    const view = await mountOn(WAYFLOW_TASK);
    const tryAgain = await view.findByTestId("list-picker-try-again");
    act(() => {
      fireEvent.click(tryAgain);
      fireEvent.click(tryAgain);
    });
    // red-first-expect: to be called 1 times, but got 0 times
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    await act(async () => finish({ ok: true }));
    expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1);
  });

  it("sends nothing from a list step on a setup gate (guard)", async () => {
    const view = await mountOn("setup-run-3562");
    fireEvent.click(await view.findByTestId("list-picker-try-again"));
    await act(async () => {});
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });
});
