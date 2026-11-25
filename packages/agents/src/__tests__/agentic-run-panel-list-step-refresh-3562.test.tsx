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
import {
  ensureDefaultFieldRenderersRegistered,
  registerFieldRendererBindings,
} from "../register-default-renderers";
import {
  __resetFieldRendererComponentMapForTests,
  __setFieldRendererComponentMapForTests,
} from "../field-renderer-components";
import { fieldRendererRegistry } from "../field-renderer-registry";
import { RunPageChrome } from "../run-page-chrome";
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

const panelToast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock("@/lib/cinatra-toast", () => ({ toast: panelToast, cinatraToast: panelToast }));

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

/** The pause's gate schema, recorded with `recorded` as its refresh value (none when null). */
const recordedWith = (recorded: string | null = "refresh") =>
  recorded === null ? { type: "string" } : { type: "string", "x-cinatra-list-step-refresh-value": recorded };

function streamResultFor(
  xRenderer: string,
  fieldName: string,
  schema: Record<string, unknown>,
  reviewTaskId: string,
  stepNumber: number | null = 1,
) {
  return {
    status: "pending_approval",
    error: null,
    presentationHint: null,
    isLive: true,
    interruptContext: {
      schema,
      xRenderer,
      values: stepNumber === null ? {} : { stepNumber },
      reviewTaskId,
      fieldName,
    },
    streamedText: "",
    dataPartFrames: [],
  };
}

async function renderPanelOn(reviewTaskId: string, recorded: string | null = "refresh") {
  const { useAgUiRunStream } = await import("../use-ag-ui-run-stream");
  (useAgUiRunStream as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
    streamResultFor(LIST_STEP_ID, "accountScope", recordedWith(recorded), reviewTaskId),
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

  it("a refused refresh shows the error toast and draws the step again, so Try again can be pressed again", async () => {
    // The server refuses (the step's place in the run is not known); the
    // server action passes that refusal on as a thrown error.
    hitlActions.approveReviewTask.mockImplementationOnce(async () => {
      throw new Error("its place in the run's steps is not known");
    });
    const view = await renderPanelOn(WAYFLOW_TASK);
    fireEvent.click(await view.findByTestId("list-picker-try-again"));
    // red-first-expect: to be called 1 times, but got 0 times
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(panelToast.error).toHaveBeenCalledWith("Could not continue this run."));

    const tryAgain = await view.findByTestId("list-picker-try-again");
    expect(productContinue()!.disabled).toBe(true);
    fireEvent.click(tryAgain);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(2));
  });

  it("a pause recorded with no refresh value sends nothing, and Continue stays unavailable", async () => {
    const view = await renderPanelOn(WAYFLOW_TASK, null);
    const tryAgain = await view.findByTestId("list-picker-try-again");
    await waitFor(() => expect(productContinue()!.disabled).toBe(true));
    fireEvent.click(tryAgain);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    expect(productContinue()!.disabled).toBe(true);
  });

  it("sends nothing from a list step on a setup gate (guard)", async () => {
    const view = await renderPanelOn("setup-run-3562");
    fireEvent.click(await view.findByTestId("list-picker-try-again"));
    await act(async () => {});
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });
});

/**
 * The list step as the pack ships it: its binding declares a component
 * (`cinatra.fieldRenderers[].component`, email-outreach-agent
 * src/renderers/list-picker.ts), so the generated component map holds the
 * binding and the host mounts the pack's component through the extension
 * wrapper, with the binding's params as `bindingParams`. This stand-in keeps
 * the pack component's no-list branch: the failed-read alert (design
 * specs/app-artifact-review.html I.1) with Try again only when the binding
 * declares `refreshValue`, and the pack's write.
 */
function PackListStep({ bindingParams, onChange, onValidityChange }: FieldRendererProps) {
  const refreshValue = bindingParams?.refreshValue;
  React.useEffect(() => {
    onValidityChange?.(false);
  }, [onValidityChange]);
  return (
    <div role="alert" data-testid="list-picker-read-failed">
      <p>This list could not be read.</p>
      {typeof refreshValue === "string" ? (
        <Button
          type="button"
          data-testid="list-picker-try-again"
          onClick={() => void onChange({ listIds: [], listNames: [], refresh: refreshValue })}
        >
          Try again
        </Button>
      ) : null}
    </div>
  );
}

describe("AgenticRunPanel — the pack's list step, mounted through the binding's component (cinatra#3562)", () => {
  function mountPackListStep(params: Record<string, unknown>) {
    fieldRendererRegistry.clear();
    __setFieldRendererComponentMapForTests({
      [LIST_STEP_ID]: {
        resolution: "guardedOptional",
        packageName: "@cinatra-ai/email-outreach-agent",
        propsApiVersion: 1,
        load: async () => ({ default: PackListStep }),
      },
    });
    ensureDefaultFieldRenderersRegistered();
    registerFieldRendererBindings([{ id: LIST_STEP_ID, kind: "list-picker", priority: 90, params }]);
  }

  afterEach(() => {
    __resetFieldRendererComponentMapForTests();
  });

  it("sends the value recorded with the pause when the failed-read alert's Try again is pressed, even when the deployed binding declares another", async () => {
    mountPackListStep({ selection: "multiple", minSelected: 1, refreshValue: "reload" });
    const view = await renderPanelOn(WAYFLOW_TASK, "refresh");
    const tryAgain = await view.findByTestId("list-picker-try-again");
    expect(view.getByTestId("list-picker-read-failed").contains(tryAgain)).toBe(true);
    await waitFor(() => expect(productContinue()!.disabled).toBe(true));

    fireEvent.click(tryAgain);
    // red-first-expect: to be called 1 times, but got 0 times
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const [taskId, payload] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(taskId).toBe(WAYFLOW_TASK);
    expect(payload).toMatchObject({ userResponse: "refresh", listStepRefresh: "refresh" });
    expect(JSON.stringify(payload)).not.toContain("reload");
    expect(payload).not.toHaveProperty("listIds");
  });

  it("draws no Try again when the binding declares no refresh value (guard)", async () => {
    mountPackListStep({ selection: "multiple", minSelected: 1 });
    const view = await renderPanelOn(WAYFLOW_TASK);
    await view.findByTestId("list-picker-read-failed");
    expect(view.queryByTestId("list-picker-try-again")).toBeNull();
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });
});

/**
 * The list step with Try again and, once a list is there, a pick: it reports
 * its value unsendable until the pick.
 */
function TryAgainOrPickRenderer({ onChange, onValidityChange }: FieldRendererProps) {
  const reportValidity = React.useRef(onValidityChange);
  reportValidity.current = onValidityChange;
  React.useEffect(() => {
    reportValidity.current?.(false);
  }, []);
  return (
    <>
      <Button
        type="button"
        data-testid="list-picker-try-again"
        onClick={() => void onChange({ listIds: [], listNames: [], refresh: "refresh" })}
      >
        Try again
      </Button>
      <Button
        type="button"
        onClick={() => {
          onValidityChange?.(true);
          void onChange({ listIds: ["L1"], listNames: ["One"] });
        }}
      >
        Pick a list
      </Button>
    </>
  );
}

/** Another step's list: a pick and nothing else. */
function PickOnlyRenderer({ onChange }: FieldRendererProps) {
  return (
    <Button type="button" onClick={() => void onChange({ listIds: ["L1"], listNames: ["One"] })}>
      Pick a list
    </Button>
  );
}

describe("AgenticRunPanel — a list step's Try again keeps the files attached for that step (cinatra#3562)", () => {
  const FILE = {
    artifactId: "art-1",
    representationRevisionId: "ver-1",
    digest: "sha256:abc",
    mime: "application/pdf",
    originKind: "upload",
    filename: "report.pdf",
  };
  const FILES_STEP_ID = "@cinatra-test/files-step:list-picker";
  const OTHER_STEP_ID = "@cinatra-test/other-step:list-picker";

  beforeEach(() => {
    for (const [id, renderer] of [
      [FILES_STEP_ID, TryAgainOrPickRenderer],
      [OTHER_STEP_ID, PickOnlyRenderer],
    ] as const) {
      fieldRendererRegistry.register({
        id,
        priority: 110,
        condition: (_fieldName, schema) => (schema as { "x-renderer"?: unknown })["x-renderer"] === id,
        renderer,
      });
    }
    windowFiles.attachments = [FILE];
  });
  afterEach(() => {
    windowFiles.attachments = null;
  });

  async function showPause(xRenderer: string, reviewTaskId: string, fieldName = "accountScope", stepNumber = 1) {
    const { useAgUiRunStream } = await import("../use-ag-ui-run-stream");
    (useAgUiRunStream as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      streamResultFor(xRenderer, fieldName, recordedWith(), reviewTaskId, stepNumber),
    );
  }

  /** The run works on the answer: it reports no pause for a moment. */
  async function showWorking() {
    const { useAgUiRunStream } = await import("../use-ag-ui-run-stream");
    (useAgUiRunStream as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      ...streamResultFor(FILES_STEP_ID, "accountScope", { type: "string" }, WAYFLOW_TASK),
      status: "running",
      interruptContext: null,
    });
  }

  async function mount() {
    await showPause(FILES_STEP_ID, WAYFLOW_TASK);
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const draw = () => (
      <RunPageChrome>
        <AgenticRunPanel
          runId="run-3562"
          initialStatus="pending_approval"
          initialError={null}
          initialMessages={[]}
          agUiEnabled
          templateId="tmpl-3562"
        />
      </RunPageChrome>
    );
    const view = render(draw());
    return { view, rerender: () => view.rerender(draw()) };
  }

  async function pickAndContinue(view: ReturnType<typeof render>, calls: number) {
    fireEvent.click(await view.findByRole("button", { name: "Pick a list" }));
    await act(async () => {});
    await waitFor(() => expect(productContinue()?.disabled).toBe(false));
    fireEvent.click(productContinue()!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(calls));
    const [, payload] = hitlActions.approveReviewTask.mock.calls[calls - 1] as unknown as [string, Record<string, unknown>];
    return payload;
  }

  it("a file attached before Try again goes with the pick after it", async () => {
    const { view, rerender } = await mount();
    fireEvent.click(await view.findByRole("button", { name: "Send with a file" }));
    await act(async () => {});
    fireEvent.click(await view.findByTestId("list-picker-try-again"));
    // red-first-expect: to be called 1 times, but got 0 times
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    await showWorking();
    rerender();
    await act(async () => {});
    // The refreshed list step pauses again as a new task.
    await showPause(FILES_STEP_ID, `${WAYFLOW_TASK}-again`);
    rerender();
    await act(async () => {});
    const payload = await pickAndContinue(view, 2);
    expect((hitlActions.approveReviewTask.mock.calls[1] as unknown as [string])[0]).toBe(`${WAYFLOW_TASK}-again`);
    const envelope = JSON.parse(payload.userResponse as string) as { attachments: Array<{ artifactId: string }> };
    expect(envelope.attachments.map((a) => a.artifactId)).toEqual(["art-1"]);
  });

  it("a file attached at a step does not go with the next step's answer (guard)", async () => {
    const { view, rerender } = await mount();
    fireEvent.click(await view.findByRole("button", { name: "Send with a file" }));
    await act(async () => {});
    // The step is answered elsewhere and the run moves to another step.
    await showWorking();
    rerender();
    await act(async () => {});
    await showPause(OTHER_STEP_ID, "wayflow-task-next", "nextScope", 2);
    rerender();
    await act(async () => {});
    const payload = await pickAndContinue(view, 1);
    expect(payload).not.toHaveProperty("userResponse");
  });

  it("a file attached before Try again does not go with another step's answer when the run moves on instead (guard)", async () => {
    const { view, rerender } = await mount();
    fireEvent.click(await view.findByRole("button", { name: "Send with a file" }));
    await act(async () => {});
    fireEvent.click(await view.findByTestId("list-picker-try-again"));
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    await showWorking();
    rerender();
    await act(async () => {});
    await showPause(OTHER_STEP_ID, "wayflow-task-next", "nextScope", 2);
    rerender();
    await act(async () => {});
    const payload = await pickAndContinue(view, 2);
    expect(payload).not.toHaveProperty("userResponse");
  });

  it("a file attached before a Try again that fails does not go with a later pause of the same renderer (guard)", async () => {
    hitlActions.approveReviewTask.mockImplementationOnce(async () => {
      throw new Error("takes no such list step refresh");
    });
    const { view, rerender } = await mount();
    fireEvent.click(await view.findByRole("button", { name: "Send with a file" }));
    await act(async () => {});
    fireEvent.click(await view.findByTestId("list-picker-try-again"));
    // red-first-expect: to be called with arguments: [ 'Could not continue this run.' ]
    await waitFor(() => expect(panelToast.error).toHaveBeenCalledWith("Could not continue this run."));
    // The step is answered elsewhere; the run reaches a later step drawn by
    // the same renderer.
    await showWorking();
    rerender();
    await act(async () => {});
    await showPause(FILES_STEP_ID, "wayflow-task-later", "accountScope", 3);
    rerender();
    await act(async () => {});
    const payload = await pickAndContinue(view, 2);
    expect(payload).not.toHaveProperty("userResponse");
  });

  it("a file attached before Try again does not go with another step drawn by the same renderer (guard)", async () => {
    const { view, rerender } = await mount();
    fireEvent.click(await view.findByRole("button", { name: "Send with a file" }));
    await act(async () => {});
    fireEvent.click(await view.findByTestId("list-picker-try-again"));
    // red-first-expect: to be called 1 times, but got 0 times
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    await showWorking();
    rerender();
    await act(async () => {});
    // The run moves on to the second list step, drawn by the same renderer.
    await showPause(FILES_STEP_ID, "wayflow-task-second-list", "accountScope", 2);
    rerender();
    await act(async () => {});
    const payload = await pickAndContinue(view, 2);
    expect(payload).not.toHaveProperty("userResponse");
  });
});
