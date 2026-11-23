// @vitest-environment jsdom
/**
 * THE SAME FILL ON THE STEP-BY-STEP SCREEN (cinatra#2934, fix leg 13).
 *
 * The drawing, `specs/app-artifact-review.html` §X: "On a surface with a form,
 * the sentence names filling — and the button stays the person's. The window
 * fills the fields the person can see with what they asked for, and nothing is
 * submitted until they press the screen's own button".
 *
 * The orchestrator stepper mounts the same window (`surface: "step-by-step"`),
 * writes a fill that did not press into its buffer and its suggestion payload,
 * and hands the host's schema-field floor the whole values envelope for a
 * string field — the same road the run page takes. So the floor's own field
 * must show the placed words before any press here too.
 *
 * Harness: orchestrator-stepper-hitl-field-label.test.tsx (the real panel on a
 * live per-field setup gate, the default renderers registered), with the
 * window's server actions mocked as run-window-fill-through-drawn-panel mocks
 * them and its field driven through the same stand-in.
 *
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/stepper-window-fill-reaches-setup-field-2934.test.tsx
 */
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import type * as RunPageChromeModule from "../run-page-chrome";
// The run page's chrome is loaded inside the tests that use it.
const RUN_PAGE_CHROME = "../run-page-chrome";

/** The round's own words. */
const W = "Why self-hosted upgrades take longer than planned";
const ASK_FILL = "Fill the idea with: Why self-hosted upgrades take longer than planned. Do not submit it.";

const windowActions = vi.hoisted(() => ({
  loadRunWindowConversation: vi.fn(),
  sendRunWindowTurn: vi.fn(),
}));
vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: (...a: unknown[]) => windowActions.loadRunWindowConversation(...a),
  sendRunWindowTurn: (...a: unknown[]) => windowActions.sendRunWindowTurn(...a),
}));

vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: (props: { onSubmit: (s: string) => Promise<void> }) => (
    <span
      role="button"
      tabIndex={0}
      data-testid="prompt-field"
      onClick={() => void props.onSubmit(ASK_FILL)}
    >
      PromptField
    </span>
  ),
}));

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

const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
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
  approveReviewTask: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../hitl-actions", () => hitlActions);

/**
 * A file waiting in the window (cinatra#3470): a send control beside the real
 * window, drawn only while `windowFiles.attachments` is set
 * (agentic-run-panel-setup-continue-3532's stand-in). Its message is empty:
 * the screen keeps the files and no turn goes to the conversation.
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
              void props.onSubmit("", windowFiles.attachments as Parameters<typeof props.onSubmit>[1])
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

// The list step's lists (cinatra#3470): one fixture list to pick.
vi.mock("../list-picker-actions", () => ({
  fetchAvailableLists: vi.fn(async () => [
    { id: "list-1", name: "Fixture list", memberCount: 3, lastUpdated: null, memberType: "contact" },
  ]),
}));

vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));

/** A gate a test parks the run on instead of the setup gate (cinatra#3470). */
const parkedGate = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: (_runId: string, opts: { initialStatus?: string }) => ({
    status: opts?.initialStatus ?? "pending_approval",
    interruptContext: parkedGate.current ?? {
      schema: {
        type: "string",
        "x-multiline": true,
        "x-placeholder": "Paste one idea, or type what this post should be about",
      },
      xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
      values: {},
      reviewTaskId: "setup-run-2934-step",
      fieldName: "idea",
    },
    messages: [],
    streamedText: "",
    presentationHint: null,
    dataPartFrames: [],
    isLive: true,
    error: null,
  }),
}));

type PanelProps = import("../orchestrator-stepper-panel").OrchestratorStepperPanelProps;

function baseProps(): PanelProps {
  return {
    runId: "run-2934-step",
    initialStatus: "pending_approval",
    initialError: null,
    agUiEnabled: false as boolean | null,
    agentPackageName: "@cinatra-ai/blog-draft-writer-agent",
    inputParams: {},
    stepperSteps: [
      { index: 1, stepNumber: 0, label: "Setup", xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID },
    ],
    agentId: "cinatra-ai/blog-draft-writer-agent",
    lgThreadId: null,
    templateId: "tmpl-2934-step",
    templateName: "Blog draft writer",
  };
}

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  windowActions.loadRunWindowConversation.mockResolvedValue([]);
  parkedGate.current = null;
  windowFiles.attachments = null;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

afterAll(() => {
  for (const id of [
    "../run-window-actions",
    "@cinatra-ai/sdk-ui",
    "lucide-react",
    "@/lib/cinatra-toast",
    "next/navigation",
    "../orchestrator-actions",
    "../run-actions",
    "../run-recommendation-actions",
    "../run-name-actions",
    "../hitl-actions",
    "../use-runtime-field-renderer-bindings",
    "../use-ag-ui-run-stream",
    "../hitl-conversation-panel",
    "../list-picker-actions",
  ]) {
    vi.doUnmock(id);
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("the step-by-step screen's setup field shows what the window placed (cinatra#2934)", () => {
  it("F3 — #field-idea holds the placed words before any press, and nothing is sent", async () => {
    windowActions.sendRunWindowTurn.mockResolvedValue({
      ok: true,
      entries: [
        { id: 1, role: "user", content: ASK_FILL },
        {
          id: 2,
          role: "assistant",
          content:
            "Placed in the fields on your screen. Nothing was submitted — press the button when you are ready.",
        },
      ],
      fills: [{ ref: "ref_1", values: { idea: W } }],
      acted: false,
    });
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    // THE PAGE OWNS THE WINDOW (cinatra#3487): the screen registers with the run
    // page's chrome, which is what draws the window the fill is typed into.
    const { RunPageChrome } = (await import(/* @vite-ignore */ RUN_PAGE_CHROME)) as typeof RunPageChromeModule;
    render(
      <RunPageChrome>
        <OrchestratorStepperPanel {...baseProps()} />
      </RunPageChrome>,
    );

    await waitFor(() => expect(document.querySelector("#field-idea")).not.toBeNull());
    await waitFor(() => expect(screen.queryByTestId("prompt-field")).not.toBeNull());
    const field = () => document.querySelector("#field-idea") as HTMLTextAreaElement;
    expect(field().value).toBe("");

    await act(async () => {
      fireEvent.click(screen.getByTestId("prompt-field"));
    });
    await waitFor(() => expect(windowActions.sendRunWindowTurn).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(document.querySelectorAll('[data-run-window-entry="assistant"]').length).toBe(1),
    );

    await waitFor(() => expect(field().value).toBe(W));
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });
});

// cinatra#3470: A DECLARED CARD ON THE STEP-BY-STEP SCREEN.
//   - An assistant fill goes through the card's one writer, so the Continue
//     sends the filled answer as the resume text (a raw merge left
//     `userResponse` missing, and the agent read the approval marker).
//   - A declared card whose binding id ends in `:setup-form` is the card, not
//     a grouped setup form: it stages what is typed and sends nothing until
//     its Continue (a suffix reading sent the first keystroke).
describe("a declared card on the step-by-step screen (cinatra#3470)", () => {
  const FIELD_SCREEN = {
    layout: "card",
    title: "Fixture question",
    sections: [{ type: "field", key: "answer", label: "Fixture answer" }],
    carry: ["itemId"],
  };

  const CHOICE_SCREEN = {
    layout: "card",
    title: "Fixture choice",
    decisionLabel: "Fixture decision",
    decisions: [
      { label: "Fixture decline", answer: { approved: false, reason: "Fixture reason" } },
      { label: "Fixture revise", answer: { action: "revise" } },
    ],
    carry: ["itemId"],
  };
  /** A gate that declares `userResponse` as the value its renderer must write. */
  const REQUIRES_USER_RESPONSE = {
    type: "object",
    properties: { userResponse: { type: "string", "x-required": true } },
  };

  async function renderDeclaredCard(
    id: string,
    declared: Record<string, unknown> = FIELD_SCREEN,
    schema: Record<string, unknown> = { type: "object" },
  ) {
    const { registerFieldRendererBindings } = await import("../register-default-renderers");
    registerFieldRendererBindings([
      { id, kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: declared },
    ]);
    parkedGate.current = {
      schema,
      xRenderer: id,
      values: { itemId: "item-1" },
      reviewTaskId: "wayflow-task-3470-step",
    };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    const { RunPageChrome } = (await import(/* @vite-ignore */ RUN_PAGE_CHROME)) as typeof RunPageChromeModule;
    render(
      <RunPageChrome>
        <OrchestratorStepperPanel
          {...baseProps()}
          stepperSteps={[{ index: 1, stepNumber: 1, label: "Fixture step", xRenderer: id }]}
        />
      </RunPageChrome>,
    );
    // red-first-expect: expected null not to be null
    await waitFor(() => expect(screen.queryByText(declared.title as string)).not.toBeNull());
  }

  /** The radio of the declared decision drawn with `name`. */
  function radio(name: RegExp): HTMLElement {
    const row = Array.from(document.querySelectorAll("label")).find((l) => name.test(l.textContent ?? ""));
    return row!.querySelector<HTMLElement>('[role="radio"]')!;
  }

  async function pressContinue(): Promise<Record<string, unknown>> {
    await waitFor(() => expect(continueButton()?.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(continueButton()!);
    });
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    return (hitlActions.approveReviewTask.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
  }

  const answerField = () => screen.getByLabelText("Fixture answer") as HTMLInputElement;
  const continueButton = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      /^Continue/.test(b.textContent ?? ""),
    );

  it("an assistant fill, then Continue, sends the filled answer as the resume text", async () => {
    windowActions.sendRunWindowTurn.mockResolvedValue({
      ok: true,
      entries: [
        { id: 1, role: "user", content: "Answer new." },
        { id: 2, role: "assistant", content: "Placed in the fields on your screen." },
      ],
      fills: [{ ref: "ref_1", values: { answer: "new" } }],
      acted: false,
    });
    await renderDeclaredCard("@acme-test/declared-agent:confirm");
    await waitFor(() => expect(screen.queryByTestId("prompt-field")).not.toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByTestId("prompt-field"));
    });
    await waitFor(() => expect(answerField().value).toBe("new"));

    await waitFor(() => expect(continueButton()?.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(continueButton()!);
    });
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const payload = (hitlActions.approveReviewTask.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(payload.userResponse).toBe(JSON.stringify({ itemId: "item-1", answer: "new" }));
    expect(payload.answer).toBe("new");
  });

  it("a declared ':setup-form' card stages what is typed and sends nothing before its Continue", async () => {
    await renderDeclaredCard("@acme-test/declared-agent:setup-form");
    fireEvent.change(answerField(), { target: { value: "f" } });
    await act(async () => {});
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    expect(answerField().value).toBe("f");

    await waitFor(() => expect(continueButton()?.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(continueButton()!);
    });
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const payload = (hitlActions.approveReviewTask.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(payload.userResponse).toBe(JSON.stringify({ itemId: "item-1", answer: "f" }));
    // The grouped setup's lift never rides along on a declared card.
    expect(Object.hasOwn(payload, "approvalNote")).toBe(false);
  });

  // Round 5, finding 1: the attachment envelope is applied last, over the
  // declared answer staged in `userResponse`, so the waiting file goes with it.
  it("a waiting file goes with a declared answer on a gate that requires `userResponse`", async () => {
    windowFiles.attachments = [
      {
        artifactId: "art-1",
        representationRevisionId: "ver-1",
        digest: "sha256:abc",
        mime: "application/pdf",
        originKind: "upload",
        filename: "report.pdf",
      },
    ];
    await renderDeclaredCard("@acme-test/declared-agent:confirm", FIELD_SCREEN, REQUIRES_USER_RESPONSE);
    fireEvent.change(answerField(), { target: { value: "typed" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Send with a file" })).not.toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send with a file" }));
    });

    const payload = await pressContinue();
    const envelope = JSON.parse(payload.userResponse as string) as {
      text?: string;
      attachments?: Array<{ artifactId: string }>;
    };
    expect(envelope.attachments?.map((a) => a.artifactId)).toEqual(["art-1"]);
    expect(envelope.text).toBe(JSON.stringify({ itemId: "item-1", answer: "typed" }));
  });

  // Round 5, finding 2: the later of two decision fills in one turn is the
  // staged decision, as the server replays the fills.
  it("two decision fills in one turn stage the later decision, as the server replays them", async () => {
    windowActions.sendRunWindowTurn.mockResolvedValue({
      ok: true,
      entries: [
        { id: 1, role: "user", content: "Decline it. No, revise it." },
        { id: 2, role: "assistant", content: "Placed in the fields on your screen." },
      ],
      fills: [
        { ref: "ref_1", values: { approved: false, reason: "Fixture reason" } },
        { ref: "ref_1", values: { action: "revise" } },
      ],
      acted: false,
    });
    await renderDeclaredCard("@acme-test/declared-agent:confirm", CHOICE_SCREEN);
    await waitFor(() => expect(screen.queryByTestId("prompt-field")).not.toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByTestId("prompt-field"));
    });
    await waitFor(() => expect(windowActions.sendRunWindowTurn).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(radio(/Fixture revise/).getAttribute("aria-checked")).toBe("true"));

    const payload = await pressContinue();
    expect(payload.userResponse).toBe(JSON.stringify({ itemId: "item-1", action: "revise" }));
    expect(Object.hasOwn(payload, "reason")).toBe(false);
    expect(payload.approved).toBe(true);
  });
});

// Round 5, finding 3: a declared list-picker kind (`screen: {layout: "kind"}`)
// holds the stepper's Continue until a usable pick exists, as every declared
// card holds it until its answer is complete. Before, the press sent an
// empty list snapshot (`listId: ""`).
describe("a declared list-picker kind on the step-by-step screen (cinatra#3470)", () => {
  const LIST_ID = "@acme-test/list-agent:pick-list";

  async function renderListStep() {
    const { registerFieldRendererBindings } = await import("../register-default-renderers");
    registerFieldRendererBindings([
      { id: LIST_ID, kind: "list-picker", priority: 90, midRunHitl: true, screen: { layout: "kind" } },
    ]);
    parkedGate.current = {
      schema: { type: "object" },
      xRenderer: LIST_ID,
      values: {},
      reviewTaskId: "wayflow-task-3470-list",
    };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    const { RunPageChrome } = (await import(/* @vite-ignore */ RUN_PAGE_CHROME)) as typeof RunPageChromeModule;
    render(
      <RunPageChrome>
        <OrchestratorStepperPanel
          {...baseProps()}
          stepperSteps={[{ index: 1, stepNumber: 1, label: "Fixture list step", xRenderer: LIST_ID }]}
        />
      </RunPageChrome>,
    );
    await waitFor(() => expect(screen.queryByText("Fixture list")).not.toBeNull());
  }

  const continueButton = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      /^Continue/.test(b.textContent ?? ""),
    );

  it("holds the Continue with nothing picked, and a press sends nothing", async () => {
    await renderListStep();
    expect(continueButton()).toBeDefined();
    // red-first-expect: expected false to be true // Object.is equality
    expect(continueButton()!.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(continueButton()!);
    });
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });

  it("sends the pick once one is made", async () => {
    await renderListStep();
    const row = screen.getByText("Fixture list").closest('[role="button"]') as HTMLElement;
    fireEvent.click(row);
    await waitFor(() => expect(continueButton()!.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(continueButton()!);
    });
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const payload = (hitlActions.approveReviewTask.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    // red-first-expect: expected 'undefined' to be 'string' // Object.is equality
    expect(typeof payload.approvalNote).toBe("string");
    expect(JSON.parse(payload.approvalNote as string)).toMatchObject({ type: "list", listId: "list-1" });
  });
});
