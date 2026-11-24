// @vitest-environment jsdom
/**
 * cinatra#3562 — THE RUN PANEL SENDS A LIST STEP'S TRY AGAIN AT ONCE.
 *
 * With no list to pick, the list step draws Try again (design
 * specs/app-artifact-review.html I.1, the failed-read alert). A press writes
 * `{ listIds: [], listNames: [], refresh: "refresh" }` and the step reports its
 * value unsendable, so the Continue stays unavailable. The panel sends that
 * write at once as the step's answer, with the refresh value as the resume
 * text: once per press, never as a pick, and only on a mid-run list step.
 *
 * Harness mirrors agentic-run-panel-setup-continue-3532.test.tsx.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/agentic-run-panel-list-step-refresh-3562.test.tsx
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

/**
 * The run window hands the panel its files through `onSubmit`'s second
 * argument. The run page draws the window without its paperclip, so a test
 * that needs a waiting file adds one send control beside the real window, and
 * only while `windowFiles.attachments` is set.
 *
 * THE MESSAGE IS EMPTY (cinatra#3487). The window is the run page chrome's,
 * and the chrome hands a message to the screen only while the screen has
 * something to manipulate, which needs the run's template. An empty message
 * still hands the files to the screen, and the run window sends nothing for an
 * empty message, so no turn goes to the run's conversation.
 */
const windowFiles = vi.hoisted(() => ({ attachments: null as null | unknown[] }));
vi.mock("../hitl-conversation-panel", async (importOriginal) => {
  const real = await importOriginal<typeof import("../hitl-conversation-panel")>();
  const { Button: WindowButton } = await import("@/components/ui/button");
  function WindowWithAFile(props: React.ComponentProps<typeof real.HitlConversationPanel>) {
    return (
      <>
        <real.HitlConversationPanel {...props} />
        {windowFiles.attachments ? (
          <WindowButton
            type="button"
            onClick={() =>
              void props.onSubmit(
                "",
                windowFiles.attachments as Parameters<typeof props.onSubmit>[1],
              )
            }
          >
            Send with a file
          </WindowButton>
        ) : null}
      </>
    );
  }
  return { ...real, HitlConversationPanel: WindowWithAFile };
});

vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(async () => null),
}));

vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-3562",
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
    streamResultFor(LIST_STEP_ID, "accountScope", { type: "string" }, WAYFLOW_TASK),
  ),
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

function streamResultFor(
  xRenderer: string,
  fieldName: string,
  schema: Record<string, unknown>,
  reviewTaskId: string,
) {
  return {
    status: "pending_approval",
    error: null,
    presentationHint: null,
    isLive: true,
    interruptContext: { schema, xRenderer, values: {}, reviewTaskId, fieldName },
    streamedText: "",
    dataPartFrames: [],
  };
}

async function renderPanelOn(reviewTaskId: string) {
  const { useAgUiRunStream } = await import("../use-ag-ui-run-stream");
  (useAgUiRunStream as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
    streamResultFor(LIST_STEP_ID, "accountScope", { type: "string" }, reviewTaskId),
  );
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  return render(
    <AgenticRunPanel
      runId="run-3562"
      initialStatus="pending_approval"
      initialError={null}
      initialMessages={[]}
      agUiEnabled
      templateId="tmpl-3562"
    />,
  );
}

function productContinue(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('[data-action="submit-hitl-screen"]');
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
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
});

describe("AgenticRunPanel — a list step's Try again (cinatra#3562)", () => {
  it("sends the refresh value at once as the step's answer, never as a pick, and keeps Continue unavailable", async () => {
    const view = await renderPanelOn(WAYFLOW_TASK);
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
    const view = await renderPanelOn(WAYFLOW_TASK);
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
    const view = await renderPanelOn("setup-run-3562");
    fireEvent.click(await view.findByTestId("list-picker-try-again"));
    await act(async () => {});
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });
});
