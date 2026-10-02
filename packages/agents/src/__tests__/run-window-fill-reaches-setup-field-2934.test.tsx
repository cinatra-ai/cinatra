// @vitest-environment jsdom
/**
 * THE FILL REACHES THE SETUP FIELD ON THE RUN PAGE (cinatra#2934, fix leg 13).
 *
 * The drawing, `specs/app-artifact-review.html` §X: "The window fills the
 * fields the person can see with what they asked for, and nothing is submitted
 * until they press the screen's own button, unless the same message plainly
 * asks for it to be submitted."
 *
 * THE MEASUREMENT (the pull request's thirteenth proof round, CELL5 and CELL6):
 * after one window message that placed the idea and asked for no submission,
 * the answer read "Placed in the fields on your screen." while `#field-idea`
 * stayed empty — and the later press sent words the field never showed.
 *
 * THE ROAD, read at the head: the panel writes a fill that did not press into
 * its buffer and into the suggestion payload it hands every renderer
 * (`aiSuggestions`). A per-field setup gate whose field declares no renderer of
 * its own draws the host's schema-field floor, and for a string field the
 * panel's `value` is the whole envelope (`setupFieldRendererValue`), which the
 * floor does not read. So the floor has to honour the shared props contract —
 * "Renderers use `useEffect([aiSuggestions])` to sync local state" — for its
 * own field.
 *
 * The panel is the REAL AgenticRunPanel on its per-field setup gate, drawn on
 * the real registered floor (harness of agentic-run-panel.single-idea-field),
 * with the window's server actions mocked exactly as
 * run-window-fill-through-drawn-panel mocks them and its field driven through
 * the same stand-in.
 *
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-window-fill-reaches-setup-field-2934.test.tsx
 */
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";

/** The round's own words. */
const W = "Why self-hosted upgrades take longer than planned";
const ASK_FILL = "Fill the idea with: Why self-hosted upgrades take longer than planned. Do not submit it.";
const ANSWER =
  "Placed in the fields on your screen. Nothing was submitted — press the button when you are ready.";

const windowActions = vi.hoisted(() => ({
  loadRunWindowConversation: vi.fn(),
  sendRunWindowTurn: vi.fn(),
}));
vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: (...a: unknown[]) => windowActions.loadRunWindowConversation(...a),
  sendRunWindowTurn: (...a: unknown[]) => windowActions.sendRunWindowTurn(...a),
}));

/** What the person types into the window before pressing its send control. */
const nextMessage = vi.hoisted(() => ({ text: "" }));

// The window's own field stands in as the control that sends the person's
// words (run-window-fill-through-drawn-panel's stand-in). A span, because the
// design-system gate forbids the bare element in favour of the shadcn control.
vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: (props: { onSubmit: (s: string) => Promise<void> }) => (
    <span
      role="button"
      tabIndex={0}
      data-testid="prompt-field"
      onClick={() => void props.onSubmit(nextMessage.text)}
    >
      PromptField
    </span>
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
    runId: "run-2934-fill",
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
  useAgUiRunStream: vi.fn(() => streamResultFor()),
}));

/** The Blog Draft Writer Agent's `idea` input as its pack declares it: a
 *  multiline string with no renderer of its own. */
const IDEA_SCHEMA = {
  type: "string",
  "x-multiline": true,
  "x-placeholder": "Paste one idea, or type what this post should be about",
};

/** The run parked on the per-field setup gate that collects `idea`. */
function streamResultFor() {
  return {
    status: "pending_approval",
    error: null,
    presentationHint: null,
    isLive: true,
    interruptContext: {
      schema: IDEA_SCHEMA,
      xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
      values: {},
      reviewTaskId: "setup-run-2934-fill",
      fieldName: "idea",
    },
    streamedText: "",
    dataPartFrames: [],
  };
}

const PANEL_PROPS = {
  runId: "run-2934-fill",
  initialStatus: "pending_approval",
  initialError: null,
  initialMessages: [],
  agUiEnabled: true,
  templateId: "tmpl-2934-fill",
};

async function renderRunPage() {
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  render(<AgenticRunPanel {...PANEL_PROPS} surface="agent-detail" />);
  await waitFor(() => expect(document.querySelector("#field-idea")).not.toBeNull());
  await waitFor(() => expect(screen.queryByTestId("prompt-field")).not.toBeNull());
}

const ideaField = () => document.querySelector("#field-idea") as HTMLTextAreaElement;

/** Type a message into the window and press its send control once; return once
 *  the turn's answer stands in the panel above the window's field. */
async function sendInWindow(message: string) {
  nextMessage.text = message;
  await act(async () => {
    fireEvent.click(screen.getByTestId("prompt-field"));
  });
  await waitFor(() => expect(windowActions.sendRunWindowTurn).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(document.querySelectorAll('[data-run-window-entry="assistant"]').length).toBe(1),
  );
  // Let the handler's own continuation (the write into the screen) settle.
  await act(async () => {});
}

/** The field's OWN Continue — the floor's control, not the window's. */
function fieldContinue(): HTMLElement {
  const buttons = Array.from(document.querySelectorAll("button")).filter((b) =>
    /continue/i.test(b.textContent ?? ""),
  );
  expect(buttons).toHaveLength(1);
  return buttons[0]!;
}

function turnOf(args: { fills: Array<{ ref: string; values: Record<string, unknown> }>; acted: boolean; ask: string }) {
  return {
    ok: true,
    entries: [
      { id: 1, role: "user", content: args.ask },
      { id: 2, role: "assistant", content: ANSWER },
    ],
    fills: args.fills,
    acted: args.acted,
  };
}

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  windowActions.loadRunWindowConversation.mockResolvedValue([]);
  nextMessage.text = "";
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

afterAll(() => {
  vi.doUnmock("../run-window-actions");
  vi.doUnmock("@cinatra-ai/sdk-ui");
  vi.doUnmock("sonner");
  vi.doUnmock("lucide-react");
  vi.doUnmock("../hitl-actions");
  vi.doUnmock("../a2a-actions");
  vi.doUnmock("../server-actions");
  vi.doUnmock("../agent-ui-override-registry");
  vi.doUnmock("../use-ag-ui-run-stream");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("the run page's setup field shows what the window placed (cinatra#2934)", () => {
  it("F1 — a fill that asked for no submission lands in #field-idea, and nothing is sent", async () => {
    windowActions.sendRunWindowTurn.mockResolvedValue(
      turnOf({ ask: ASK_FILL, fills: [{ ref: "ref_1", values: { idea: W } }], acted: false }),
    );
    await renderRunPage();
    expect(ideaField().value).toBe("");

    await sendInWindow(ASK_FILL);

    await waitFor(() => expect(ideaField().value).toBe(W));
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    expect(hitlActions.rejectReviewTask).not.toHaveBeenCalled();
  });

  it("F2 — the field's own Continue sends exactly the words the field showed", async () => {
    windowActions.sendRunWindowTurn.mockResolvedValue(
      turnOf({ ask: ASK_FILL, fills: [{ ref: "ref_1", values: { idea: W } }], acted: false }),
    );
    await renderRunPage();
    await sendInWindow(ASK_FILL);

    const shown = ideaField().value;
    await act(async () => {
      fireEvent.click(fieldContinue());
    });

    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const [reviewTaskId, payload] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(reviewTaskId).toBe("setup-run-2934-fill");
    expect(payload.idea).toBe(W);
    expect(payload.idea).toBe(shown);
  });

  it("F4 — a turn that placed nothing leaves the field exactly as the person typed it", async () => {
    windowActions.sendRunWindowTurn.mockResolvedValue(
      turnOf({ ask: "What is this field for?", fills: [], acted: false }),
    );
    await renderRunPage();
    fireEvent.change(ideaField(), { target: { value: "my own words" } });
    expect(ideaField().value).toBe("my own words");

    await sendInWindow("What is this field for?");

    expect(ideaField().value).toBe("my own words");
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });

  it("F5 — a turn that pressed writes no field, even when it carried a fill", async () => {
    windowActions.sendRunWindowTurn.mockResolvedValue(
      turnOf({
        ask: "Set the idea to: Why self-hosted upgrades take longer than planned, and submit it.",
        fills: [{ ref: "ref_1", values: { idea: W } }],
        acted: true,
      }),
    );
    await renderRunPage();
    fireEvent.change(ideaField(), { target: { value: "typed before the turn" } });

    await sendInWindow(
      "Set the idea to: Why self-hosted upgrades take longer than planned, and submit it.",
    );

    expect(ideaField().value).toBe("typed before the turn");
    expect(ideaField().value).not.toBe(W);
  });
});
